/** Channel type IDs used in binary COMMAND packets when opening a channel. */
export enum ChannelType {
  UAUT = 7,
  UCFG = 2,
  INFO = 20,
  CTPP = 16,
  CSPB = 17,
  // PUSH uses same wire type as UCFG; device distinguishes by channel name string
  PUSH = 2,
}

/** Message IDs used in JSON message-id fields — different from ChannelType. */
export enum ViperMessageId {
  UAUT = 2,
  UCFG = 3,
  SERVER_INFO = 20,
  PUSH = 2,
}

export class AsyncQueue<T> {
  private items: T[] = [];
  private waiters: Array<(item: T | null) => void> = [];

  enqueue(item: T): void {
    if (this.waiters.length > 0) {
      const waiter = this.waiters.shift()!;
      waiter(item);
    } else {
      this.items.push(item);
    }
  }

  dequeue(timeoutMs = 30_000): Promise<T | null> {
    if (this.items.length > 0) {
      return Promise.resolve(this.items.shift()!);
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const idx = this.waiters.indexOf(resolve);
        if (idx >= 0) this.waiters.splice(idx, 1);
        resolve(null);
      }, timeoutMs);
      this.waiters.push((item) => {
        clearTimeout(timer);
        resolve(item);
      });
    });
  }

  clear(): void {
    for (const w of this.waiters) w(null);
    this.waiters = [];
    this.items = [];
  }
}

export class AsyncMutex {
  private locked = false;
  private queue: Array<() => void> = [];

  acquire(): Promise<void> {
    if (!this.locked) {
      this.locked = true;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.queue.push(resolve));
  }

  release(): void {
    if (this.queue.length > 0) {
      this.queue.shift()!();
    } else {
      this.locked = false;
    }
  }
}

export interface ChannelState {
  name: string;
  channelType: ChannelType;
  requestId: number;
  serverChannelId: number;
  sequence: number;
  isOpen: boolean;
  openBody: Buffer;
  _openResolve?: (body: Buffer) => void;
  _openReject?: (err: Error) => void;
  responseQueue: AsyncQueue<Buffer>;
  sendMutex: AsyncMutex;
}

export function createChannel(
  name: string,
  channelType: ChannelType,
  requestId: number,
): ChannelState {
  return {
    name,
    channelType,
    requestId,
    serverChannelId: 0,
    sequence: 1,
    isOpen: false,
    openBody: Buffer.alloc(0),
    responseQueue: new AsyncQueue<Buffer>(),
    sendMutex: new AsyncMutex(),
  };
}

export function nextSequence(channel: ChannelState): number {
  const seq = channel.sequence;
  channel.sequence += 2;
  return seq;
}
