/**
 * Wire protocol encoding/decoding for the ICONA Bridge TCP protocol.
 * Faithful TypeScript translation of the Python protocol.py.
 *
 * Header format (8 bytes):
 *   [0x00 0x06] [body_len LE16] [request_id LE16] [0x00 0x00]
 */

import { VIDEO_FPS, VIDEO_HEIGHT, VIDEO_WIDTH } from './settings';

export const HEADER_SIZE = 8;
export const HEADER_MAGIC = Buffer.from([0x00, 0x06]);

const CTPP_INIT_FLAGS1 = Buffer.from([0x00, 0x11]);
const CTPP_INIT_FLAGS2 = Buffer.from([0x00, 0x40]);
const CTPP_INIT_SEPARATOR = Buffer.from([0x10, 0x0e]);
const CTPP_INIT_ZERO_PAD = Buffer.from([0x00, 0x00, 0x00, 0x00]);
const CTPP_ADDR_WILDCARD = Buffer.from([0xff, 0xff, 0xff, 0xff]);
const CTPP_LEGACY_TS = Buffer.from([0x5c, 0x8b, 0x2b, 0x73]);

export const enum MessageType {
  COMMAND = 0xabcd,
  END = 0x01ef,
  OPEN_DOOR_INIT = 0x18c0,
  OPEN_DOOR = 0x1800,
  OPEN_DOOR_CONFIRM = 0x1820,
}

export const ACTION_CALL_INIT = 0x0028;
export const ACTION_CODEC_NEG = 0x0008;
export const ACTION_RTPC_LINK = 0x000a;
export const ACTION_VIDEO_CONFIG = 0x001a;
export const ACTION_PEER = 0x0070;
export const ACTION_CONFIG_ACK = 0x000e;
export const ACTION_HANGUP = 0x002d;
export const ACTION_DOOR_OPEN = 0x000d;

// ─── Header ──────────────────────────────────────────────────────────────────

export function encodeHeader(bodyLength: number, requestId = 0): Buffer {
  const buf = Buffer.alloc(HEADER_SIZE);
  buf[0] = 0x00;
  buf[1] = 0x06;
  buf.writeUInt16LE(bodyLength, 2);
  buf.writeUInt16LE(requestId, 4);
  return buf;
}

export function decodeHeader(data: Buffer): { bodyLength: number; requestId: number } {
  if (data.length < HEADER_SIZE) throw new Error(`Header too short: ${data.length}`);
  return {
    bodyLength: data.readUInt16LE(2),
    requestId: data.readUInt16LE(4),
  };
}

// ─── JSON messages ────────────────────────────────────────────────────────────

export function encodeJsonMessage(msg: Record<string, unknown>, requestId: number): Buffer {
  const body = Buffer.from(JSON.stringify(msg), 'utf8');
  return Buffer.concat([encodeHeader(body.length, requestId), body]);
}

export function decodeJsonBody(body: Buffer): Record<string, unknown> {
  return JSON.parse(body.toString('utf8')) as Record<string, unknown>;
}

export function isJsonBody(body: Buffer): boolean {
  return body.length > 0 && body[0] === 0x7b; // '{'
}

// ─── Channel open/close ───────────────────────────────────────────────────────

export function encodeChannelOpen(
  channelName: string,
  channelTypeId: number,
  sequence: number,
  requestId: number,
  extraData?: string,
  trailingByte = 0,
): Buffer {
  const parts: Buffer[] = [];
  const seq = Buffer.alloc(4);
  seq.writeUInt16LE(MessageType.COMMAND, 0);
  seq.writeUInt16LE(sequence, 2);
  parts.push(seq);

  const typeBuf = Buffer.alloc(4);
  typeBuf.writeUInt32LE(channelTypeId, 0);
  parts.push(typeBuf);

  parts.push(Buffer.from(channelName, 'ascii'));

  const reqBuf = Buffer.alloc(3);
  reqBuf.writeUInt16LE(requestId, 0);
  reqBuf[2] = trailingByte;
  parts.push(reqBuf);

  if (extraData) {
    const extraBytes = Buffer.from(extraData, 'ascii');
    const lenBuf = Buffer.alloc(5);
    lenBuf[0] = 0x00; // PCAP-verified pad byte
    lenBuf.writeUInt32LE(extraBytes.length + 1, 1);
    parts.push(lenBuf);
    parts.push(extraBytes);
    parts.push(Buffer.from([0x00]));
  }

  const body = Buffer.concat(parts);
  return Buffer.concat([encodeHeader(body.length, 0), body]);
}

export function encodeChannelOpenResponse(requestId: number): Buffer {
  const body = Buffer.alloc(8);
  body.writeUInt16LE(MessageType.COMMAND, 0);
  body.writeUInt16LE(2, 2); // seq=2
  body.writeUInt32LE(4, 4);
  const tail = Buffer.alloc(4);
  tail.writeUInt16LE(requestId, 0);
  const full = Buffer.concat([body, tail]);
  return Buffer.concat([encodeHeader(full.length, 0), full]);
}

export function encodeChannelClose(sequence: number, serverChannelId = 0): Buffer {
  const body = Buffer.alloc(4);
  body.writeUInt16LE(MessageType.END, 0);
  body.writeUInt16LE(sequence, 2);
  return Buffer.concat([encodeHeader(body.length, serverChannelId), body]);
}

export function parseCommandResponse(body: Buffer): { msgType: number; seq: number; serverChannelId: number } {
  const msgType = body.readUInt16LE(0);
  const seq = body.readUInt16LE(2);
  const serverChannelId = body.length >= 10 ? body.readUInt16LE(8) : 0;
  return { msgType, seq, serverChannelId };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function nullTerminated(s: string): Buffer {
  return Buffer.concat([Buffer.from(s, 'ascii'), Buffer.from([0x00])]);
}

function le16(v: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(v, 0);
  return b;
}
function le32(v: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(v, 0);
  return b;
}
function be16(v: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(v, 0);
  return b;
}

// ─── CTPP init ────────────────────────────────────────────────────────────────

export function encodeCttpInit(
  aptAddress: string,
  aptSubaddress: number,
  timestamp?: number,
): Buffer {
  const addrWithSub = `${aptAddress}${aptSubaddress}`;
  const ts = timestamp ?? undefined;
  const tsBuf = ts !== undefined ? le32(ts) : CTPP_LEGACY_TS;
  const mystery = le16((ts ?? 0x238bac) & 0xffff);

  return Buffer.concat([
    le16(0x18c0),
    tsBuf,
    CTPP_INIT_FLAGS1,
    CTPP_INIT_FLAGS2,
    mystery,
    nullTerminated(addrWithSub),
    CTPP_INIT_SEPARATOR,
    CTPP_INIT_ZERO_PAD,
    CTPP_ADDR_WILDCARD,
    nullTerminated(addrWithSub),
    nullTerminated(aptAddress),
    Buffer.from([0x00]),
  ]);
}

// ─── Door open payloads ───────────────────────────────────────────────────────

export function encodeOpenDoor(
  msgType: number,
  aptAddress: string,
  outputIndex: number,
  doorAptAddress: string,
): Buffer {
  return Buffer.concat([
    le16(msgType),
    Buffer.from([0x5c, 0x8b]),
    Buffer.from([0x2c, 0x74, 0x00, 0x00]),
    Buffer.from([0xff, 0xff, 0xff, 0xff]),
    nullTerminated(`${aptAddress}${outputIndex}`),
    nullTerminated(doorAptAddress),
    Buffer.from([0x00]),
  ]);
}

export function encodeDoorInit(
  aptAddress: string,
  outputIndex: number,
  doorAptAddress: string,
): Buffer {
  return Buffer.concat([
    Buffer.from([0xc0, 0x18, 0x70, 0xab]),
    Buffer.from([0x29, 0x9f, 0x00, 0x0d]),
    Buffer.from([0x00, 0x2d]),
    nullTerminated(doorAptAddress),
    Buffer.from([0x00]),
    le32(outputIndex),
    Buffer.from([0xff, 0xff, 0xff, 0xff]),
    nullTerminated(`${aptAddress}${outputIndex}`),
    nullTerminated(doorAptAddress),
    Buffer.from([0x00]),
  ]);
}

export function encodeActuatorInit(
  aptAddress: string,
  outputIndex: number,
  actuatorAptAddress: string,
): Buffer {
  return Buffer.concat([
    Buffer.from([0xc0, 0x18, 0x45, 0xbe]),
    Buffer.from([0x8f, 0x5c, 0x00, 0x04]),
    Buffer.from([0x00, 0x20, 0xff, 0x01]),
    Buffer.from([0xff, 0xff, 0xff, 0xff]),
    nullTerminated(`${aptAddress}${outputIndex}`),
    nullTerminated(actuatorAptAddress),
    Buffer.from([0x00]),
  ]);
}

export function encodeActuatorOpen(
  aptAddress: string,
  outputIndex: number,
  actuatorAptAddress: string,
  confirm = false,
): Buffer {
  return Buffer.concat([
    Buffer.from([confirm ? 0x20 : 0x00, 0x18, 0x45, 0xbe]),
    Buffer.from([0x8f, 0x5c, 0x00, 0x04]),
    Buffer.from([0xff, 0xff, 0xff, 0xff]),
    nullTerminated(`${aptAddress}${outputIndex}`),
    nullTerminated(actuatorAptAddress),
    Buffer.from([0x00]),
  ]);
}

// ─── Video call payloads ──────────────────────────────────────────────────────

function buildCtppVideoMsg(
  prefix: number,
  timestamp: number,
  action: number,
  flags: number,
  caller: string,
  callee: string,
  extra: Buffer = Buffer.alloc(0),
): Buffer {
  return Buffer.concat([
    le16(prefix),
    le32(timestamp),
    be16(action),
    be16(flags),
    extra,
    Buffer.from([0xff, 0xff, 0xff, 0xff]),
    nullTerminated(caller),
    Buffer.from(callee, 'ascii'),
    Buffer.from([0x00, 0x00]),
  ]);
}

export function encodeCallInit(caller: string, callee: string, timestamp: number): Buffer {
  return Buffer.concat([
    le16(0x18c0),
    le32(timestamp),
    be16(ACTION_CALL_INIT),
    be16(0x0001),
    Buffer.from(caller, 'ascii'), Buffer.from([0x00]),
    Buffer.from(callee, 'ascii'), Buffer.from([0x00, 0x00]),
    Buffer.from([0x01, 0x20]),
    le32((timestamp ^ 0xc0d31185) >>> 0),
    Buffer.from(caller, 'ascii'), Buffer.from([0x00]),
    Buffer.from('II'),
    Buffer.from([0xff, 0xff, 0xff, 0xff]),
    Buffer.from(caller, 'ascii'), Buffer.from([0x00]),
    Buffer.from(callee, 'ascii'), Buffer.from([0x00, 0x00]),
  ]);
}

export function encodeCallAck(caller: string, callee: string, timestamp: number): Buffer {
  return buildCtppVideoMsg(
    0x1840, timestamp, ACTION_CODEC_NEG, 0x0003,
    caller, callee,
    Buffer.from([0x49, 0x00, 0x27, 0x00, 0x00, 0x00]),
  );
}

export function encodeRtpcLink(
  caller: string,
  callee: string,
  rtpcReqId: number,
  timestamp: number,
  refresh = false,
): Buffer {
  const extra = Buffer.alloc(10);
  extra[0] = refresh ? 0x98 : 0x18;
  extra[1] = 0x02;
  extra.writeUInt16LE(rtpcReqId, 6);
  return buildCtppVideoMsg(0x1840, timestamp, ACTION_RTPC_LINK, 0x0011, caller, callee, extra);
}

export function encodeVideoConfig(
  caller: string,
  callee: string,
  rtpc2ReqId: number,
  timestamp: number,
  width = VIDEO_WIDTH,
  height = VIDEO_HEIGHT,
  fps = VIDEO_FPS,
): Buffer {
  const extra = Buffer.alloc(24);
  extra[0] = 0x14; extra[1] = 0x32;
  extra.writeUInt16LE(rtpc2ReqId, 6);
  extra[8] = 0xff; extra[9] = 0xff;
  extra.writeUInt16LE(width, 12);
  extra.writeUInt16LE(height, 14);
  extra.writeUInt16LE(320, 16);
  extra.writeUInt16LE(240, 18);
  extra.writeUInt16LE(fps, 20);
  return buildCtppVideoMsg(0x1840, timestamp, ACTION_VIDEO_CONFIG, 0x0011, caller, callee, extra);
}

export function encodeCallResponseAck(
  caller: string,
  callee: string,
  timestamp: number,
  prefix = 0x1800,
): Buffer {
  return Buffer.concat([
    le16(prefix),
    le32(timestamp),
    be16(0x0000),
    Buffer.from([0xff, 0xff, 0xff, 0xff]),
    nullTerminated(caller),
    Buffer.from(callee, 'ascii'),
    Buffer.from([0x00, 0x00]),
  ]);
}

export function encodeHangup(caller: string, entranceAddr: string, timestamp: number): Buffer {
  return Buffer.concat([
    le16(0x1830),
    le32(timestamp),
    be16(ACTION_HANGUP),
    Buffer.from(entranceAddr, 'ascii'), Buffer.from([0x00]),
    Buffer.from([0xff, 0xff, 0xff, 0xff]),
    nullTerminated(caller),
    Buffer.from(entranceAddr, 'ascii'), Buffer.from([0x00, 0x00]),
  ]);
}

export function encodeDoorOpenDuringVideo(
  ourAddr: string,
  entranceAddr: string,
  callCounter: number,
  relayIndex: number,
): Buffer {
  const ourB = Buffer.alloc(10);
  const enrB = Buffer.alloc(10);
  Buffer.from(ourAddr, 'ascii').copy(ourB);
  Buffer.from(entranceAddr, 'ascii').copy(enrB);

  return Buffer.concat([
    le16(0x1840),
    le32(callCounter),
    be16(ACTION_DOOR_OPEN),
    be16(0x002d),
    enrB,
    le32(relayIndex),
    Buffer.from([0xff, 0xff, 0xff, 0xff]),
    ourB,
    enrB,
  ]);
}

// ─── RTP header ───────────────────────────────────────────────────────────────

export interface RtpHeader {
  version: number;
  padding: boolean;
  extension: boolean;
  csrcCount: number;
  marker: boolean;
  payloadType: number;
  sequence: number;
  timestamp: number;
  ssrc: number;
}

export function decodeRtpHeader(data: Buffer): { header: RtpHeader; payload: Buffer } {
  if (data.length < HEADER_SIZE + 12) {
    throw new Error(`Packet too short for ICONA+RTP: ${data.length}`);
  }
  const rtp = data.subarray(HEADER_SIZE);
  const b0 = rtp[0];
  const b1 = rtp[1];
  return {
    header: {
      version: (b0 >> 6) & 0x03,
      padding: Boolean((b0 >> 5) & 0x01),
      extension: Boolean((b0 >> 4) & 0x01),
      csrcCount: b0 & 0x0f,
      marker: Boolean((b1 >> 7) & 0x01),
      payloadType: b1 & 0x7f,
      sequence: rtp.readUInt16BE(2),
      timestamp: rtp.readUInt32BE(4),
      ssrc: rtp.readUInt32BE(8),
    },
    payload: rtp.subarray(12),
  };
}
