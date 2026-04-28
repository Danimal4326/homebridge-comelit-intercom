import { ChannelState } from './channels';
import { IconaBridgeClient } from './client';
import { encodeCallResponseAck, encodeCttpInit } from './protocol';

export const CTR_INCR_BOTH = 0x01010000;
const CTPP_RESPONSE_MIN_LEN = 8;

export async function ctppInitSequence(
  client: IconaBridgeClient,
  channel: ChannelState,
  aptAddr: string,
  aptSub: number,
  ourAddr: string,
  timestamp: number,
  responseTimeoutMs = 5_000,
  sendAck = true,
): Promise<void> {
  await client.sendBinary(channel, encodeCttpInit(aptAddr, aptSub, timestamp));

  await readResponseCtpp(client, channel, responseTimeoutMs);

  if (sendAck) {
    const ackTs = (timestamp + CTR_INCR_BOTH) & 0xffffffff;
    await client.sendBinary(channel, encodeCallResponseAck(ourAddr, aptAddr, ackTs));
    await client.sendBinary(channel, encodeCallResponseAck(ourAddr, aptAddr, ackTs, 0x1820));
  }
}

export async function readResponseCtpp(
  client: IconaBridgeClient,
  channel: ChannelState,
  responseTimeoutMs = 5_000,
): Promise<void> {
  for (let i = 0; i < 2; i++) {
    const resp = await client.readResponse(channel, responseTimeoutMs);
    if (resp && resp.length >= CTPP_RESPONSE_MIN_LEN) {
      // responses logged at caller's discretion
    }
  }
}
