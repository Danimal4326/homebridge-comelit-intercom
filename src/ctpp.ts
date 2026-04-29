import { ChannelState } from './channels';
import { IconaBridgeClient } from './client';
import { encodeCallResponseAck, encodeCttpInit } from './protocol';

export const CTR_INCR_BOTH = 0x01010000;
const CTPP_RESPONSE_MIN_LEN = 8;
const PREFIX_VIP_EVENT = 0x1860;
const ACK_TS_INCREMENT = 0x01000000;

type Logger = { debug: (m: string, ...a: unknown[]) => void; info: (m: string, ...a: unknown[]) => void };

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

  await readResponseCtpp(client, channel, responseTimeoutMs, log, { aptAddr, aptSub, ourAddr });

  if (sendAck) {
    const ackTs = (timestamp + CTR_INCR_BOTH) >>> 0;
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
  ackConfig?: { aptAddr: string; aptSub: number; ourAddr: string },
): Promise<void> {
  // Read up to two responses from the device after the CTPP init. The device
  // typically sends [0x1800 init ACK][0x1860 initial-burst renewal] in quick
  // succession. If a renewal (0x1860) is seen here we ACK it immediately — this
  // gets the ACK out within a few ms while the device's acceptance window is still
  // open, giving the connection the best chance of surviving into periodic-renewal
  // mode. Without the fast ACK the device sends EOF before the VIP listener can
  // respond. If the device sends fewer than two responses the extras time out.
  for (let i = 0; i < 2; i++) {
    const resp = await client.readResponse(channel, responseTimeoutMs);
    if (resp && resp.length >= CTPP_RESPONSE_MIN_LEN) {
      const prefix = resp.readUInt16LE(0);
      log?.info(`CTPP init response ${i + 1}: ${resp.length} bytes prefix=0x${prefix.toString(16).padStart(4, '0')} hex=${resp.subarray(0, Math.min(resp.length, 32)).toString('hex')}`);

      if (prefix === PREFIX_VIP_EVENT && ackConfig) {
        const { aptAddr, aptSub, ourAddr } = ackConfig;
        const vipAddr = ourAddr; // aptAddr + aptSub, already concatenated by caller
        const msgTs = resp.readUInt32LE(2);
        const ackTs = (msgTs + ACK_TS_INCREMENT) >>> 0;
        log?.info(`CTPP init: sending fast renewal ACK ts=0x${ackTs.toString(16)}`);
        try {
          await client.sendBinary(channel, encodeCallResponseAck(vipAddr, aptAddr, ackTs));
          await client.sendBinary(channel, encodeCallResponseAck(vipAddr, aptAddr, ackTs, 0x1820));
        } catch {
          log?.info('CTPP init: fast renewal ACK failed (connection closing)');
        }
      }
    } else {
      log?.info(`CTPP init response ${i + 1}: timeout (no data)`);
    }
  }
}
