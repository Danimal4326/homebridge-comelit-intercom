# Comelit Intercom — Homebridge Plugin + Home Assistant Component

Local integration for the **Comelit 6701W** WiFi video intercom. Communicates entirely via the ICONA Bridge TCP protocol on port 64100 — no cloud required.

This repository contains two integrations built from the same protocol stack:

| | Platform | Status |
|---|---|---|
| 🍎 | **Homebridge 2.0 plugin** | This branch — `homebridge-comelit-intercom` npm package |
| 🏠 | **Home Assistant component** | `custom_components/comelit_intercom_local/` |

---

## Homebridge 2.0 Plugin

### Features

- **Door locks** — one `LockMechanism` accessory per door/gate relay; tap to open in the Home app
- **Doorbell** — fires a HomeKit doorbell event on ring, triggering native iOS/macOS notifications
- **RTSP cameras** — exposes any RTSP cameras reported by the device config
- **100% local** — all TCP traffic stays on your LAN

### Prerequisites

- Node.js 18 or newer
- Homebridge 2.0 (beta or stable)
- Comelit 6701W accessible on your LAN
- Your device's 32-character hex token (see [Finding your token](#finding-your-token))

### Installation

#### From npm (once published)

```bash
npm install -g homebridge-comelit-intercom
```

Then restart Homebridge and add the platform via the Homebridge UI.

#### From source (this repo)

```bash
# Clone
git clone https://github.com/Danimal4326/homebridge-comelit-intercom.git
cd homebridge-comelit-intercom

# Install dependencies and build
npm install
npm run build

# Link into your global Homebridge installation
npm link
```

Then restart Homebridge.

### Finding your token

1. Browse to `http://<device-ip>:8080` (default credentials: `admin` / `comelit`)
2. Go to **Device Info** — copy the **ID32** field (32-character hex string)

### Configuration

Add a platform entry to your Homebridge `config.json`:

```json
{
  "platforms": [
    {
      "platform": "ComelitIntercom",
      "name": "Comelit Intercom",
      "host": "192.168.1.100",
      "token": "your32charhextoken...",
      "port": 64100,
      "enableNotifications": true,
      "reconnectDelay": 10
    }
  ]
}
```

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `platform` | ✅ | — | Must be `ComelitIntercom` |
| `name` | ✅ | — | Display name shown in Homebridge UI |
| `host` | ✅ | — | Device IP address or hostname |
| `token` | ✅ | — | 32-char hex token from device admin page |
| `port` | | `64100` | ICONA Bridge TCP port |
| `enableNotifications` | | `true` | Open a persistent CTPP channel for doorbell ring events. Disable only for troubleshooting. |
| `reconnectDelay` | | `10` | Seconds to wait before reconnecting after a drop |

If you use the **Homebridge UI** (Config UI X), the plugin schema is in `config.schema.json` and all fields will appear as a form automatically.

### Build

```bash
npm run build      # compile TypeScript → dist/
npm run watch      # watch mode for development
```

Output lands in `dist/`. The plugin entry point is `dist/index.js`.

### Accessories

After Homebridge discovers the device, the following accessories appear in the Home app:

| Accessory | HAP Service | Description |
|-----------|-------------|-------------|
| One per door/gate | `LockMechanism` | Tap **Open** to trigger the relay. Shows as "Unlocked" briefly then returns to "Locked" after 3 s. |
| Doorbell | `Doorbell` + `Speaker` | Fires a ring event when someone presses the physical doorbell. Triggers a native HomeKit notification. |
| RTSP cameras (if any) | `MotionSensor` (stub) | Cameras found in device config are registered. Full HomeKit streaming is a planned future addition. |

### Usage

**Opening a door**

In the Home app, find the door accessory (e.g. *Actuator* or *Entrance Lock*) and tap **Open**. The lock icon briefly shows open, the relay fires, then it locks again automatically.

You can also use Shortcuts or automations:

```
Siri: "Hey Siri, unlock Front Door"
```

**Doorbell notifications**

When someone rings, your iPhone/iPad/Mac receives a HomeKit notification. No automation required — it works out of the box once the plugin is running.

To also trigger a scene or other action when the bell rings, create a **HomeKit automation** in the Home app:
- Trigger: *Doorbell detects doorbell*
- Action: anything (turn on a light, unlock a different door, etc.)

**Reconnection**

The plugin reconnects automatically if the device goes to sleep or the network drops. The `reconnectDelay` setting controls how long it waits before trying again. A 90-second PUSH keepalive prevents false disconnects when the device is idle.

---

## Home Assistant Component

> The HA component lives in `custom_components/comelit_intercom_local/`. The instructions below apply to that platform only.

### Features

- **Remote door opening** — open doors/gates from Home Assistant
- **Live intercom video** — view the door camera stream directly in HA dashboards via local RTSP
- **Doorbell events** — automations trigger on ring or missed call
- **Custom Lovelace card** — play-button UI auto-registered on startup; starts video on click, stops on navigation away
- **100% local** — all communication stays on your LAN, no cloud required

### Requirements

- Comelit 6701W (or compatible ICONA Bridge device)
- Device accessible on your local network
- Home Assistant 2026.1+

### Installation

#### HACS (Recommended)

1. Add this repository as a custom repository in HACS
2. Install **Comelit Intercom Local**
3. Restart Home Assistant

#### Manual

1. Copy the `custom_components/comelit_intercom_local/` folder to your HA `config/custom_components/` directory
2. Restart Home Assistant

### Configuration

1. Go to **Settings → Devices & Services → Add Integration**
2. Search for **Comelit Intercom Local**
3. Enter your device IP and either:
   - Your device password (token will be extracted automatically), or
   - A pre-extracted 32-character hex token

#### Notification settings

After setup, configure via **Settings → Integrations → Comelit Intercom Local → Configure**:

| Option | Default | Description |
|--------|---------|-------------|
| Enable notifications | On | Receive doorbell ring and door events. Disable if you only need video and door control, or to troubleshoot the notification connection. |

### Entities

| Entity | Description |
|--------|-------------|
| `button.comelit_intercom_<door_name>` | Press to open a door or gate |
| `button.comelit_intercom_start_video_feed` | Manually start the intercom video call |
| `button.comelit_intercom_stop_video_feed` | Stop the active video call |
| `camera.comelit_intercom_live_feed` | Live video stream from the door panel via local RTSP |
| `event.comelit_intercom_doorbell` | Fires `doorbell_ring` and `missed_call` events for automations |

### Lovelace Cards

Two custom cards are automatically registered on startup.

**Intercom camera card:**

```yaml
type: custom:comelit-intercom-card
camera_entity: camera.comelit_intercom_live_feed
start_entity: button.comelit_intercom_start_video_feed  # optional
stop_entity: button.comelit_intercom_stop_video_feed
```

**Doorbell notification card:**

```yaml
type: custom:comelit-doorbell-card
doorbell_entity: event.comelit_intercom_doorbell
camera_entity: camera.comelit_intercom_live_feed
start_entity: button.comelit_intercom_start_video_feed
stop_entity: button.comelit_intercom_stop_video_feed
dismiss_after: 30  # optional, default 30s
```

### Doorbell Automations

**Basic notification:**

```yaml
alias: "Notify on doorbell ring"
triggers:
  - platform: state
    entity_id: event.comelit_intercom_doorbell
    to: "doorbell_ring"
actions:
  - action: notify.mobile_app_your_phone
    data:
      title: "Doorbell"
      message: "Someone is at the door!"
```

---

## Protocol

The ICONA Bridge protocol runs over raw TCP on port 64100. Every message has an 8-byte header:

```
[0x00 0x06] [body_length LE16] [request_id LE16] [0x00 0x00]
```

Key operations:
- **Auth**: Open UAUT channel → send JSON access request with token → expect code 200
- **Config**: Open UCFG channel → request config → parse doors, cameras, addresses
- **VIP events**: Persistent CTPP channel — binary messages for doorbell ring, door opened, renewal ACK
- **Door open (fast path)**: Reuse open CTPP channel, fire open+confirm (~30 ms)
- **Door open (standalone)**: Open transient CTPP → full init → binary sequence → close
- **Keepalive**: push-info re-sent every 90 s; device ACKs with JSON, resetting the idle timer

## Acknowledgments

Protocol knowledge derived from community reverse-engineering:
- [ha-component-comelit-intercom](https://github.com/nicolas-fricke/ha-component-comelit-intercom) — Nicolas Fricke
- [comelit-client](https://github.com/madchicken/comelit-client) — Pierpaolo Follia
- [Protocol analysis](https://grdw.nl/2023/01/28/my-intercom-part-1.html) — grdw

## License

Apache 2.0
