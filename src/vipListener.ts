/**
 * VIP event listener — monitors a persistent CTPP channel for doorbell and call events.
 *
 * Binary CTPP message format:
 *   [prefix LE16] [timestamp LE32] [action BE16] [flags/param BE16]
 *   [extra bytes] [0xFFFFFFFF] [caller\0] [callee\0\0]
 */

import { ChannelState } from './channels';
import { IconaBridgeClient } from './client';
import { DeviceConfig, PushEvent } from './models';
import { encodeCallResponseAck } from './protocol';

const PREFIX_ACK = 0x1800;
const PREFIX_CONFIRM = 0x1820;
const PREFIX_VIDEO_EVENT = 0x1840;
const PREFIX_VIP_EVENT = 0x1860;
const PREFIX_CALL_INIT = 0x18c0;

const ACTION_IN_ALERTING = 0x0001;
const ACTION_DOOR_OPENED = 0x0003;
const ACTION_REGISTRATION_RENEWAL = 0x0010;

// Event ACK: only ONE counter increments (matches Python vip_listener.py)
const ACK_TS_INCREMENT = 0x01000000;

const MIN_MSG_SIZE = 8;
const DEDUP_WINDOW_MS = 10_000;

interface CtppMessage {
  prefix: number;
  timestamp: number;
  action: number;
  flags?: number;
  addresses: string[];
  raw: Buffer;
}

function parseCtppMessage(data: Buffer): CtppMessage | null {
  if (data.length < MIN_MSG_SIZE) return null;
  const prefix = data.readUInt16LE(0);
  const timestamp = data.readUInt32LE(2);
  const action = data.readUInt16BE(6);

  const msg: CtppMessage = { prefix, timestamp, action, addresses: [], raw: data };
  if (data.length >= 10) msg.flags = data.readUInt16BE(8);

  // Extract addresses: null-terminated ASCII strings that follow the 0xFFFFFFFF marker.
  // This approach works for both "SB"-prefixed addresses and all-numeric addresses.
  const addresses: string[] = [];
  let markerIdx = -1;
  for (let i = 0; i <= data.length - 4; i++) {
    if (data[i] === 0xff && data[i + 1] === 0xff && data[i + 2] === 0xff && data[i + 3] === 0xff) {
      markerIdx = i;
      break;
    }
  }
  if (markerIdx >= 0) {
    let i = markerIdx + 4;
    while (i < data.length) {
      const nullIdx = data.indexOf(0, i);
      if (nullIdx < 0 || nullIdx === i) break;
      addresses.push(data.subarray(i, nullIdx).toString('ascii'));
      i = nullIdx + 1;
    }
  }
  msg.addresses = addresses;
  return msg;
}

export class VipEventListener {
  private channel?: ChannelState;
  private running = false;
  private loopPromise?: Promise<void>;
  private lastFired = new Map<string, number>();
  private lastSeenTs = new Map<string, [number, number]>(); // key → [ts, wallTime]

  constructor(
    private readonly client: IconaBridgeClient,
    private readonly config: DeviceConfig,
    private readonly callback: (event: PushEvent) => void,
    private readonly log?: { debug: (m: string, ...a: unknown[]) => void; info: (m: string, ...a: unknown[]) => void; warn: (m: string, ...a: unknown[]) => void },
  ) {}

  async start(): Promise<void> {
    const ctpp = this.client.getChannel('CTPP');
    if (!ctpp) throw new Error('CTPP channel not open');
    this.channel = ctpp;
    this.running = true;
    this.loopPromise = this._listenLoop().catch((e) =>
      this.log?.warn(`VIP listener loop exited: ${(e as Error).message}`),
    );
  }

  async stop(): Promise<void> {
    this.running = false;
    this.channel?.responseQueue.clear();
    if (this.loopPromise) {
      await this.loopPromise.catch(() => undefined);
      this.loopPromise = undefined;
    }
  }

  private async _listenLoop(): Promise<void> {
    const channel = this.channel!;
    while (this.running) {
      const data = await channel.responseQueue.dequeue(60_000);
      if (!this.running) break;
      if (data !== null) {
        await this._processMessage(data).catch((e) =>
          this.log?.warn(`VIP: error processing message: ${(e as Error).message}`),
        );
      }
    }
  }

  private async _processMessage(data: Buffer): Promise<void> {
    const msg = parseCtppMessage(data);
    if (!msg) return;

    const { prefix, action } = msg;
    const now = Date.now();
    const key = `${prefix}:${action}`;
    const last = this.lastSeenTs.get(key);
    const isRetransmit = last !== undefined && last[0] === msg.timestamp && now - last[1] < 10_000;
    this.lastSeenTs.set(key, [msg.timestamp, now]);

    this.log?.debug(`VIP msg: prefix=0x${prefix.toString(16).padStart(4, '0')} action=0x${action.toString(16).padStart(4, '0')} ts=0x${msg.timestamp.toString(16)} addrs=${msg.addresses.join(',')}`);

    // Periodic registration renewal — ACK with 0x1800+0x1820 pair
    if (prefix === PREFIX_VIP_EVENT && action === ACTION_REGISTRATION_RENEWAL) {
      this.log?.info(`VIP: renewal hex=${data.subarray(0, Math.min(data.length, 48)).toString('hex')}`);
      await this._sendRenewalAck(msg);
      return;
    }

    // ACK call-init (0x18C0) messages
    if (prefix === PREFIX_CALL_INIT) {
      await this._sendEventAck(msg);
    }

    // ACK all 0x1840 and 0x1860 events (matches Python vip_listener.py)
    if (prefix === PREFIX_VIDEO_EVENT || prefix === PREFIX_VIP_EVENT) {
      await this._sendEventAck(msg);
    }

    if (isRetransmit && prefix === PREFIX_VIDEO_EVENT) return;

    if (prefix === PREFIX_CALL_INIT) {
      this._fireEvent('doorbell_ring', msg.addresses);
      return;
    }

    if (prefix === PREFIX_VIP_EVENT && action !== 0) {
      if (action === ACTION_IN_ALERTING) {
        this._fireEvent('doorbell_ring', msg.addresses);
      } else if (action === ACTION_DOOR_OPENED) {
        this._fireEvent('door_opened', msg.addresses);
      }
    }
  }

  private async _sendEventAck(msg: CtppMessage): Promise<void> {
    if (!this.running) return;
    const channel = this.channel;
    if (!channel) return;
    const vipAddress = `${this.config.aptAddress}${this.config.aptSubaddress}`;
    const entranceAddr = msg.addresses[0] ?? this.config.aptAddress;
    const ackTs = (msg.timestamp + ACK_TS_INCREMENT) >>> 0;
    try {
      await this.client.sendBinary(channel, encodeCallResponseAck(vipAddress, entranceAddr, ackTs));
    } catch (e) {
      this.log?.warn(`VIP: failed to send event ACK: ${(e as Error).message}`);
    }
  }

  private async _sendRenewalAck(msg: CtppMessage): Promise<void> {
    if (!this.running) return;
    const channel = this.channel;
    if (!channel) return;
    const vipAddress = `${this.config.aptAddress}${this.config.aptSubaddress}`;
    const aptAddr = this.config.aptAddress;
    const ackTs = (msg.timestamp + ACK_TS_INCREMENT) >>> 0;
    this.log?.debug(`VIP: renewal ACK ts=0x${ackTs.toString(16)} caller=${vipAddress} callee=${aptAddr} msg-addrs=${msg.addresses.join(',')}`);
    try {
      await this.client.sendBinary(channel, encodeCallResponseAck(vipAddress, aptAddr, ackTs));
      await this.client.sendBinary(channel, encodeCallResponseAck(vipAddress, aptAddr, ackTs, 0x1820));
      this.log?.info('VIP: sent renewal ACK pair');
    } catch (e) {
      this.log?.warn(`VIP: failed to send renewal ACK: ${(e as Error).message}`);
    }
  }

  private _fireEvent(eventType: string, addresses: string[]): void {
    const now = Date.now();
    const last = this.lastFired.get(eventType) ?? 0;
    if (now - last < DEDUP_WINDOW_MS) return;
    this.lastFired.set(eventType, now);

    this.log?.info(`VIP: firing ${eventType} (addrs=${addresses.join(',')})`);
    const caller = addresses[0] ?? '';
    try {
      this.callback({
        eventType,
        aptAddress: caller,
        timestamp: now / 1000,
        raw: { source: 'ctpp_vip', addresses },
      });
    } catch {
      // callback errors must not crash the listener
    }
  }
}
