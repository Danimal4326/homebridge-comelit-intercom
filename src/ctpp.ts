import { ChannelState } from './channels';
import { IconaBridgeClient } from './client';
import { encodeCallResponseAck, encodeCttpInit } from './protocol';

export const CTR_INCR_BOTH = 0x01010000;
const CTPP_RESPONSE_MIN_LEN = 8;

type Logger = { debug: (m: string, ...a: unknown[]) => void };

export async function ctppInitSequence(
  client: IconaBridgeClient,
  channel: ChannelState,
  aptAddr: string,
  aptSub: number,
  ourAddr: string,
  timestamp: number,
  responseTimeoutMs = 5_000,
  sendAck = true,
  log?: Logger,
): Promise<void> {
  log?.debug(`CTPP init: sending init ts=0x${timestamp.toString(16)} addr=${ourAddr}`);
  await client.sendBinary(channel, encodeCttpInit(aptAddr, aptSub, timestamp));

  await readResponseCtpp(client, channel, responseTimeoutMs, log);

  if (sendAck) {
    const ackTs = (timestamp + CTR_INCR_BOTH) & 0xffffffff;
    log?.debug(`CTPP init: sending ACK pair ackTs=0x${ackTs.toString(16)} caller=${ourAddr} callee=${aptAddr}`);
    await client.sendBinary(channel, encodeCallResponseAck(ourAddr, aptAddr, ackTs));
    await client.sendBinary(channel, encodeCallResponseAck(ourAddr, aptAddr, ackTs, 0x1820));
    log?.debug('CTPP init: ACK pair sent');
  }
}

export async function readResponseCtpp(
  client: IconaBridgeClient,
  channel: ChannelState,
  responseTimeoutMs = 5_000,
  log?: Logger,
): Promise<void> {
  for (let i = 0; i < 2; i++) {
    const resp = await client.readResponse(channel, responseTimeoutMs);
    if (resp && resp.length >= CTPP_RESPONSE_MIN_LEN) {
      const prefix = resp.readUInt16LE(0);
      log?.debug(`CTPP init response ${i + 1}: ${resp.length} bytes prefix=0x${prefix.toString(16).padStart(4, '0')} hex=${resp.subarray(0, Math.min(resp.length, 16)).toString('hex')}`);
    } else {
      log?.debug(`CTPP init response ${i + 1}: timeout (no data)`);
    }
  }
}
