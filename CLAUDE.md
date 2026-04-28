# homebridge-comelit-intercom — Project Guide

## Overview

Homebridge 2.0 plugin for the **Comelit 6701W** WiFi video intercom. Communicates entirely locally via the **ICONA Bridge TCP protocol** on port 64100 — no cloud dependency.

## Project Structure

```
src/
  index.ts          — plugin entry point; registers ComelitIntercomPlatform
  settings.ts       — constants (port, timeouts, intervals)
  models.ts         — TypeScript interfaces (Door, Camera, DeviceConfig, PushEvent)
  protocol.ts       — Buffer-based wire protocol: header, channel open/close, door
                      payloads, CTPP video messages, RTP header decode
  channels.ts       — ChannelType/ViperMessageId enums; AsyncQueue, AsyncMutex;
                      ChannelState interface and factory
  client.ts         — IconaBridgeClient: Node.js net.Socket TCP client with 120 s
                      dead-connection timeout, per-channel response queues, dispatch
  auth.ts           — UAUT channel authentication
  configReader.ts   — UCFG channel: fetch and parse DeviceConfig
  ctpp.ts           — ctppInitSequence: shared CTPP init/handshake used by VIP
                      listener and standalone door open
  door.ts           — openDoor: fast path (reuse open CTPP) or standalone (transient
                      CTPP_DOOR channel with full init)
  push.ts           — PUSH channel registration + sendPushKeepalive (90 s interval)
  vipListener.ts    — VipEventListener: persistent CTPP listener; doorbell_ring,
                      door_opened, renewal ACK pair, 10 s event dedup
  platform.ts       — ComelitIntercomPlatform: DynamicPlatformPlugin; owns client,
                      VIP listener, keepalive timer, reconnect loop, accessory registry
  accessories/
    lockAccessory.ts      — LockMechanism: triggers relay, auto-secures after 3 s
    doorbellAccessory.ts  — Doorbell + Speaker: fires HAP ring event from VIP events
    cameraAccessory.ts    — stub for RTSP cameras found in device config
```

## Setup & Development

**Requirements:** Node.js 18+, Homebridge 2.0

```bash
npm install          # install dependencies
npm run build        # compile TypeScript → dist/
npm run watch        # watch mode
npm link             # link into global Homebridge for local testing
```

## ICONA Bridge Protocol

All communication is raw TCP on port **64100**. Every message has an 8-byte header:

```
[0x00 0x06] [body_length LE16] [request_id LE16] [0x00 0x00]
```

### Channels and Flow

1. **UAUT** — Authentication: open channel → send JSON access request with token → expect code 200
2. **UCFG** — Configuration: request config → parse doors, cameras, apt_address
3. **PUSH** — Notifications: registers FCM token; also used as keepalive probe (re-send push-info every 90s — device ACKs with JSON, resetting the idle timer)
4. **CTPP** — Persistent channel for VIP events (doorbell ring, door opened) and door control

### Critical Protocol Rules

- **Channel open sequence must always be 1** — device ignores packets with seq != 1
- **Timeout must be >= 30s** — device can be very slow to respond
- **Request ID** starts semi-random (8000+) and increments per message
- After channel open, server responds with `server_channel_id` used for subsequent messages
- JSON messages use compact format (no spaces)
- VIP CTPP channel uses `ChannelType.UAUT` (7) — faithful to the original coordinator; standalone door CTPP uses `ChannelType.CTPP` (16)

## Key Behavioural Notes

- **120 s dead-connection timeout**: `IconaBridgeClient` resets a timer on every received packet. If nothing arrives for 120 s the connection is declared dead and the disconnect callback fires.
- **90 s keepalive**: `sendPushKeepalive` re-registers the PUSH channel; the device's JSON ACK resets the 120 s timer.
- **Reconnect loop**: `ComelitIntercomPlatform.onClientDisconnect()` schedules `setupDevice()` after `reconnectDelay` seconds.
- **CTPP ACK timestamps**: All outgoing ACKs use `init_ts + 0x01010000` (PCAP-verified). The VIP listener derives `ackTs` once at construction time and reuses it for all renewals and event ACKs.
- **Event dedup**: `VipEventListener` suppresses duplicate events within a 10 s window (device retransmits call-init every ~1–2 s).
- **Door auto-secure**: `LockAccessory` transitions to SECURED 3 s after opening regardless of relay success or failure.

## Testing Device

- HTTP port: `8080`, ICONA port: `64100`
- Credentials: `admin` / `comelit`, token in `.env` (COMELIT_TOKEN)
- Config: apt_address=SB000006, apt_subaddress=1, 2 doors (Actuator, Entrance Lock), 0 cameras

## Coding Conventions

- `async/await` throughout — all network I/O is Promise-based
- Protocol encoding lives in `protocol.ts`; business logic in module-specific files
- `AsyncQueue<T>` (in `channels.ts`) replaces Python's `asyncio.Queue`
- `AsyncMutex` (in `channels.ts`) replaces Python's `asyncio.Lock`
- Compact JSON serialization for all messages to device

## Workflow Preferences

- **Use expert agents (subagents) whenever possible** — delegate research, code exploration, and independent subtasks to subagents to parallelize work and keep the main context clean.
