/**
 * Node.js TCP client for the ICONA Bridge protocol.
 * Translates the Python asyncio-based IconaBridgeClient to Node.js net.Socket.
 */

import net from 'net';
import { EventEmitter } from 'events';
import {
  ChannelState,
  ChannelType,
  createChannel,
  nextSequence,
} from './channels';
import {
  HEADER_SIZE,
  decodeHeader,
  decodeJsonBody,
  encodeChannelClose,
  encodeChannelOpen,
  encodeChannelOpenResponse,
  encodeHeader,
  encodeJsonMessage,
  isJsonBody,
  parseCommandResponse,
} from './protocol';
import {
  CONNECT_TIMEOUT_MS,
  DEAD_CONNECTION_TIMEOUT_MS,
  ICONA_BRIDGE_PORT,
  READ_TIMEOUT_MS,
} from './settings';

export class ConnectionError extends Error {}
export class ProtocolError extends Error {}

export class IconaBridgeClient extends EventEmitter {
  private socket: net.Socket | null = null;
  private rxBuffer: Buffer = Buffer.alloc(0);
  private requestIdCounter: number;
  private sequenceCounter = 0;
  private channels = new Map<string, ChannelState>();
  private pendingCallbacks = new Map<number, (body: Buffer) => void>();
  private pushCallback?: (msg: Record<string, unknown>) => void;
  private disconnectCallback?: () => void;
  private deadTimer?: NodeJS.Timeout;
  private _connected = false;

  constructor(
    public readonly host: string,
    public readonly port = ICONA_BRIDGE_PORT,
    private readonly log?: { debug: (m: string, ...a: unknown[]) => void; info: (m: string, ...a: unknown[]) => void; warn: (m: string, ...a: unknown[]) => void; error: (m: string, ...a: unknown[]) => void },
  ) {
    super();
    this.requestIdCounter = 8000 + Math.floor(Math.random() * 1000);
  }

  get connected(): boolean {
    return this._connected;
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: this.host, port: this.port });

      const timeout = setTimeout(() => {
        socket.destroy();
        reject(new ConnectionError(`Connect to ${this.host}:${this.port} timed out`));
      }, CONNECT_TIMEOUT_MS);

      socket.once('connect', () => {
        clearTimeout(timeout);
        this.socket = socket;
        this._connected = true;
        socket.setMaxListeners(0); // prevent accumulation across reconnect cycles
        socket.setKeepAlive(true, 60_000);
        socket.on('data', (chunk: Buffer) => this._onData(chunk));
        socket.on('end', () => this._onDisconnect('EOF'));
        socket.on('error', (err) => this._onDisconnect(`socket error: ${err.message}`));
        socket.on('close', () => { if (this._connected) this._onDisconnect('close'); });
        this._resetDeadTimer();
        this.log?.debug(`Connected to ${this.host}:${this.port}`);
        resolve();
      });

      socket.once('error', (err) => {
        clearTimeout(timeout);
        reject(new ConnectionError(`Failed to connect to ${this.host}:${this.port}: ${err.message}`));
      });
    });
  }

  async disconnect(): Promise<void> {
    this._connected = false;
    this._clearDeadTimer();
    for (const ch of this.channels.values()) {
      ch.responseQueue.clear();
      if (ch._openReject) ch._openReject(new ConnectionError('Disconnected'));
    }
    this.channels.clear();
    for (const cb of this.pendingCallbacks.values()) {
      cb(Buffer.alloc(0));
    }
    this.pendingCallbacks.clear();
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
    this.rxBuffer = Buffer.alloc(0);
    this.log?.debug(`Disconnected from ${this.host}:${this.port}`);
  }

  setDisconnectCallback(cb: () => void): void {
    this.disconnectCallback = cb;
  }

  setPushCallback(cb: ((msg: Record<string, unknown>) => void) | undefined): void {
    this.pushCallback = cb;
  }

  // ─── Send ──────────────────────────────────────────────────────────────────

  private _send(data: Buffer): Promise<void> {
    if (!this.socket) return Promise.reject(new ConnectionError('Not connected'));
    return new Promise((resolve, reject) => {
      this.socket!.write(data, (err) => {
        if (err) reject(new ConnectionError(`Send failed: ${err.message}`));
        else resolve();
      });
    });
  }

  // ─── Receive loop ─────────────────────────────────────────────────────────

  private _onData(chunk: Buffer): void {
    this._resetDeadTimer();
    this.rxBuffer = Buffer.concat([this.rxBuffer, chunk]);
    this._drainBuffer();
  }

  private _drainBuffer(): void {
    while (this.rxBuffer.length >= HEADER_SIZE) {
      const { bodyLength, requestId } = decodeHeader(this.rxBuffer);
      const totalLen = HEADER_SIZE + bodyLength;
      if (this.rxBuffer.length < totalLen) break;
      const body = this.rxBuffer.subarray(HEADER_SIZE, totalLen);
      this.rxBuffer = this.rxBuffer.subarray(totalLen);
      this._dispatch(requestId, body);
    }
  }

  private _onDisconnect(reason: string): void {
    if (!this._connected) return;
    this._connected = false;
    this._clearDeadTimer();
    this.log?.info(`Connection lost (${reason})`);
    for (const ch of this.channels.values()) {
      ch.responseQueue.clear();
      if (ch._openReject) ch._openReject(new ConnectionError('Disconnected'));
    }
    for (const cb of this.pendingCallbacks.values()) cb(Buffer.alloc(0));
    this.pendingCallbacks.clear();
    if (this.disconnectCallback) this.disconnectCallback();
  }

  private _resetDeadTimer(): void {
    this._clearDeadTimer();
    this.deadTimer = setTimeout(() => {
      this.log?.warn('No data for 120 s — marking connection dead');
      this._onDisconnect('120 s timeout');
    }, DEAD_CONNECTION_TIMEOUT_MS);
  }

  private _clearDeadTimer(): void {
    if (this.deadTimer) {
      clearTimeout(this.deadTimer);
      this.deadTimer = undefined;
    }
  }

  // ─── Dispatch ─────────────────────────────────────────────────────────────

  private _dispatch(requestId: number, body: Buffer): void {
    if (requestId === 0) {
      this._handleControlMessage(body);
      return;
    }

    // Check waiting callback (send_json)
    const cb = this.pendingCallbacks.get(requestId);
    if (cb) {
      this.pendingCallbacks.delete(requestId);
      cb(body);
      return;
    }

    // Route to channel queue
    for (const ch of this.channels.values()) {
      if (ch.serverChannelId === requestId && ch.isOpen) {
        ch.responseQueue.enqueue(body);
        return;
      }
    }

    // Unsolicited JSON → push callback
    if (isJsonBody(body)) {
      try {
        const msg = decodeJsonBody(body);
        if (this.pushCallback) this.pushCallback(msg);
      } catch {
        this.log?.debug(`Failed to decode unsolicited body on channel ${requestId}`);
      }
    }
  }

  private _handleControlMessage(body: Buffer): void {
    if (body.length < 4) return;
    const { msgType, seq, serverChannelId } = parseCommandResponse(body);

    if (msgType === 0xabcd && seq === 1 && body.length >= 10) {
      // Device-initiated channel open: find request_id from body
      let devReqId = 0;
      const nameStart = 8;
      try {
        const nullIdx = body.indexOf(0, nameStart);
        devReqId = nullIdx >= 0 ? body.readUInt16LE(nullIdx + 1) : body.readUInt16LE(body.length - 3);
      } catch {
        devReqId = body.readUInt16LE(body.length - 3);
      }
      this.socket?.write(encodeChannelOpenResponse(devReqId));
      // Assign to first placeholder channel
      for (const ch of this.channels.values()) {
        if (!ch.isOpen && ch.serverChannelId === 0 && ch.requestId === 0) {
          ch.serverChannelId = devReqId;
          ch.isOpen = true;
          ch.sequence = 3;
          ch.openBody = body;
          if (ch._openResolve) ch._openResolve(body);
          return;
        }
      }
      return;
    }

    if (msgType === 0xabcd) {
      // Regular channel open response — assign to first pending channel
      for (const ch of this.channels.values()) {
        if (!ch.isOpen && ch.serverChannelId === 0 && ch.requestId !== 0) {
          ch.serverChannelId = serverChannelId;
          ch.isOpen = true;
          ch.sequence = seq + 1;
          ch.openBody = body;
          if (ch._openResolve) ch._openResolve(body);
          return;
        }
      }
      return;
    }

    if (msgType === 0x01ef && body.length >= 8) {
      const subType = body.readUInt32LE(4);
      if (subType === 2) {
        // Device-initiated close — ACK with type=4
        const ackBody = Buffer.alloc(10);
        ackBody.writeUInt16LE(0x01ef, 0);
        ackBody.writeUInt16LE(4, 2);
        ackBody.writeUInt32LE(4, 4);
        ackBody.writeUInt16LE(serverChannelId, 8);
        const ack = Buffer.concat([
          Buffer.from([0x00, 0x06]),
          Buffer.alloc(2), // will be written below
          Buffer.alloc(4),
          ackBody,
        ]);
        ack.writeUInt16LE(ackBody.length, 2);
        this.socket?.write(ack);
      }
    }
  }

  // ─── Channel management ───────────────────────────────────────────────────

  openChannel(
    name: string,
    channelType: ChannelType,
    extraData?: string,
    trailingByte = 0,
    wireName?: string,
  ): Promise<ChannelState> {
    const protocolName = wireName ?? name;
    const requestId = ++this.requestIdCounter;
    const channel = createChannel(name, channelType, requestId);
    this.channels.set(name, channel);

    const packet = encodeChannelOpen(protocolName, channelType, 1, requestId, extraData, trailingByte);

    return new Promise((resolve, reject) => {
      channel._openResolve = () => resolve(channel);
      channel._openReject = reject;

      const timer = setTimeout(() => {
        reject(new ProtocolError(`Timeout waiting for channel ${name} to open`));
      }, READ_TIMEOUT_MS);

      const origResolve = channel._openResolve;
      channel._openResolve = (body: Buffer) => {
        clearTimeout(timer);
        origResolve(body);
      };
      channel._openReject = (err: Error) => {
        clearTimeout(timer);
        reject(err);
      };

      this._send(packet).catch(reject);
    });
  }

  async closeChannel(name: string): Promise<void> {
    const channel = this.channels.get(name);
    if (!channel) return;
    this.channels.delete(name);
    const seq = ++this.sequenceCounter;
    await this._send(encodeChannelClose(seq, channel.serverChannelId));
  }

  async sendJson(channel: ChannelState, msg: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!channel.isOpen || channel.serverChannelId === 0) {
      throw new ProtocolError(`Channel ${channel.name} not open`);
    }

    await channel.sendMutex.acquire();
    try {
      const responsePromise = new Promise<Buffer>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.pendingCallbacks.delete(channel.serverChannelId);
          reject(new ProtocolError(`Timeout waiting for response on ${channel.name}`));
        }, READ_TIMEOUT_MS);

        this.pendingCallbacks.set(channel.serverChannelId, (body) => {
          clearTimeout(timer);
          resolve(body);
        });
      });

      await this._send(encodeJsonMessage(msg, channel.serverChannelId));
      const body = await responsePromise;
      if (!isJsonBody(body)) throw new ProtocolError(`Expected JSON on ${channel.name}`);
      return decodeJsonBody(body);
    } finally {
      channel.sendMutex.release();
    }
  }

  async sendBinary(channel: ChannelState, data: Buffer): Promise<void> {
    if (!channel.isOpen || channel.serverChannelId === 0) {
      throw new ProtocolError(`Channel ${channel.name} not open`);
    }
    const packet = Buffer.concat([encodeHeader(data.length, channel.serverChannelId), data]);
    await this._send(packet);
  }

  readResponse(channel: ChannelState, timeoutMs = READ_TIMEOUT_MS): Promise<Buffer | null> {
    return channel.responseQueue.dequeue(timeoutMs);
  }

  registerPlaceholderChannel(name: string): ChannelState {
    const channel = createChannel(name, ChannelType.UAUT, 0);
    this.channels.set(name, channel);
    return channel;
  }

  releasePlaceholderChannel(name: string): void {
    this.channels.delete(name);
  }

  removeChannel(name: string): void {
    this.channels.delete(name);
  }

  renameChannel(oldName: string, newName: string): void {
    const ch = this.channels.get(oldName);
    if (ch) {
      this.channels.delete(oldName);
      ch.name = newName;
      this.channels.set(newName, ch);
    }
  }

  getChannel(name: string): ChannelState | undefined {
    const ch = this.channels.get(name);
    return ch?.isOpen ? ch : undefined;
  }
}
