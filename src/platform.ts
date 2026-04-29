import {
  API,
  DynamicPlatformPlugin,
  Logger,
  PlatformAccessory,
  PlatformConfig,
  Service,
  Characteristic,
} from 'homebridge';
import { PLATFORM_NAME, PLUGIN_NAME, KEEPALIVE_INTERVAL_MS, DEFAULT_RECONNECT_DELAY_MS } from './settings';
import { IconaBridgeClient } from './client';
import { AuthenticationError, authenticate } from './auth';
import { getDeviceConfig } from './configReader';
import { registerPush, sendPushKeepalive } from './push';
import { ctppInitSequence } from './ctpp';
import { ChannelType } from './channels';
import { DeviceConfig, Door, PushEvent } from './models';
import { openDoor } from './door';
import { VipEventListener } from './vipListener';
import { LockAccessory } from './accessories/lockAccessory';
import { DoorbellAccessory } from './accessories/doorbellAccessory';
import { CameraAccessory } from './accessories/cameraAccessory';

export interface ComelitConfig extends PlatformConfig {
  host: string;
  port?: number;
  token: string;
  enableNotifications?: boolean;
  reconnectDelay?: number;
}

export class ComelitIntercomPlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;

  public readonly cachedAccessories: PlatformAccessory[] = [];
  private lockAccessories = new Map<string, LockAccessory>();
  private doorbellAccessory?: DoorbellAccessory;
  private cameraAccessories = new Map<string, CameraAccessory>();

  private client?: IconaBridgeClient;
  private config_: DeviceConfig | undefined;
  private vipListener?: VipEventListener;
  private keepaliveTimer?: NodeJS.Timeout;
  private reconnectTimer?: NodeJS.Timeout;
  private pushCallbacks: Array<(event: PushEvent) => void> = [];

  constructor(
    public readonly log: Logger,
    public readonly platformConfig: ComelitConfig,
    public readonly api: API,
  ) {
    this.Service = this.api.hap.Service;
    this.Characteristic = this.api.hap.Characteristic;

    this.api.on('didFinishLaunching', () => {
      this.setupDevice().catch((e) =>
        this.log.error(`Initial setup failed: ${(e as Error).message}`),
      );
    });

    this.api.on('shutdown', () => {
      this.teardown();
    });
  }

  configureAccessory(accessory: PlatformAccessory): void {
    this.cachedAccessories.push(accessory);
  }

  // ─── Device lifecycle ─────────────────────────────────────────────────────

  private async setupDevice(): Promise<void> {
    const { host, port, token, enableNotifications = true } = this.platformConfig;

    if (!host || !token) {
      this.log.error('Missing required config: host and token are required');
      return;
    }

    this.log.info(`Connecting to ${host}:${port ?? 64100} …`);

    const client = new IconaBridgeClient(host, port, this.log);
    try {
      await client.connect();
    } catch (e) {
      this.log.error(`Connection failed: ${(e as Error).message}`);
      this.scheduleReconnect();
      return;
    }

    try {
      await authenticate(client, token);
      this.log.info('Authenticated');
    } catch (e) {
      this.log.error(`Authentication failed: ${(e as Error).message}`);
      await client.disconnect();
      this.scheduleReconnect();
      return;
    }

    let deviceConfig: DeviceConfig;
    try {
      deviceConfig = await getDeviceConfig(client);
      this.log.info(
        `Device config: ${deviceConfig.doors.length} door(s), apt=${deviceConfig.aptAddress}${deviceConfig.aptSubaddress}`,
      );
    } catch (e) {
      this.log.error(`Config fetch failed: ${(e as Error).message}`);
      await client.disconnect();
      this.scheduleReconnect();
      return;
    }

    try {
      await registerPush(client, deviceConfig, (event) => this.onPushEvent(event));
    } catch (e) {
      this.log.warn(`Push registration failed (non-fatal): ${(e as Error).message}`);
    }

    // Set up client and disconnect callback before CTPP init so that if the
    // device closes during the handshake, onClientDisconnect fires and the
    // reconnect loop is properly triggered.
    this.client = client;
    this.config_ = deviceConfig;
    client.setDisconnectCallback(() => this.onClientDisconnect());

    if (enableNotifications) {
      try {
        await this.openCtppChannels(client, deviceConfig);
        this.log.info('CTPP channels open for VIP events');
      } catch (e) {
        this.log.warn(`CTPP setup failed (notifications disabled): ${(e as Error).message}`);
      }
    }

    if (enableNotifications && client.getChannel('CTPP')) {
      const listener = new VipEventListener(client, deviceConfig, (ev) => this.onPushEvent(ev), this.log);
      this.vipListener = listener;
      await listener.start().catch((e) =>
        this.log.warn(`VIP listener start failed: ${(e as Error).message}`),
      );
    }

    this.startKeepalive(deviceConfig);
    this.discoverAccessories(deviceConfig);

    this.log.info('Comelit Intercom ready');
  }

  private async openCtppChannels(
    client: IconaBridgeClient,
    config: DeviceConfig,
  ): Promise<void> {
    const ourAddr = `${config.aptAddress}${config.aptSubaddress}`;
    // VIP CTPP uses ChannelType.UAUT (7) — faithful to coordinator.py
    await client.openChannel('CTPP', ChannelType.UAUT, ourAddr);
    await client.openChannel('CSPB', ChannelType.UAUT);
    const ts = (Date.now() / 1000) | 0;
    const ctpp = client.getChannel('CTPP')!;
    await ctppInitSequence(client, ctpp, config.aptAddress, config.aptSubaddress, ourAddr, ts, 5_000, true, this.log);
  }

  private teardown(): void {
    this.stopKeepalive();
    clearTimeout(this.reconnectTimer);
    this.vipListener?.stop().catch(() => undefined);
    this.vipListener = undefined;
    this.client?.disconnect().catch(() => undefined);
    this.client = undefined;
  }

  private onClientDisconnect(): void {
    this.log.warn('Device disconnected — scheduling reconnect');
    this.stopKeepalive();
    this.vipListener?.stop().catch(() => undefined);
    this.vipListener = undefined;
    this.client = undefined;
    // Mark all doors as unreachable
    for (const lock of this.lockAccessories.values()) {
      lock.onDisconnect();
    }
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    clearTimeout(this.reconnectTimer);
    const delayMs = (this.platformConfig.reconnectDelay ?? 10) * 1000;
    this.log.info(`Reconnecting in ${delayMs / 1000} s …`);
    this.reconnectTimer = setTimeout(() => {
      this.setupDevice().catch((e) =>
        this.log.error(`Reconnect failed: ${(e as Error).message}`),
      );
    }, delayMs);
  }

  // ─── Keepalive ────────────────────────────────────────────────────────────

  private startKeepalive(config: DeviceConfig): void {
    this.stopKeepalive();
    this.keepaliveTimer = setInterval(async () => {
      if (!this.client) return;
      try {
        await sendPushKeepalive(this.client, config);
      } catch (e) {
        this.log.warn(`Keepalive failed: ${(e as Error).message}`);
      }
    }, KEEPALIVE_INTERVAL_MS);
  }

  private stopKeepalive(): void {
    if (this.keepaliveTimer) {
      clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = undefined;
    }
  }

  // ─── Push events ──────────────────────────────────────────────────────────

  private onPushEvent(event: PushEvent): void {
    this.log.info(`Event: ${event.eventType} from ${event.aptAddress}`);
    if (event.eventType === 'doorbell_ring') {
      this.doorbellAccessory?.triggerRing();
    }
    for (const cb of this.pushCallbacks) {
      try { cb(event); } catch { /* ignore */ }
    }
  }

  addPushCallback(cb: (event: PushEvent) => void): void {
    this.pushCallbacks.push(cb);
  }

  // ─── Door open ────────────────────────────────────────────────────────────

  async openDoor(door: Door): Promise<void> {
    if (!this.client || !this.config_) {
      throw new Error('Not connected');
    }
    await openDoor(this.client, this.config_, door);
  }

  // ─── Accessory discovery ──────────────────────────────────────────────────

  private discoverAccessories(config: DeviceConfig): void {
    const staleUuids = new Set(this.cachedAccessories.map((a) => a.UUID));

    // Door locks
    for (const door of config.doors) {
      const uuid = this.api.hap.uuid.generate(`${PLUGIN_NAME}-lock-${door.index}`);
      staleUuids.delete(uuid);

      let accessory = this.cachedAccessories.find((a) => a.UUID === uuid);
      const isNew = !accessory;
      if (!accessory) {
        accessory = new this.api.platformAccessory(door.name || `Door ${door.index + 1}`, uuid);
        accessory.context.door = door;
      }

      const lockAcc = new LockAccessory(this, accessory, door);
      this.lockAccessories.set(uuid, lockAcc);

      if (isNew) {
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        this.log.info(`Registered door: ${door.name}`);
      } else {
        this.api.updatePlatformAccessories([accessory]);
      }
    }

    // Doorbell (one per platform instance)
    {
      const uuid = this.api.hap.uuid.generate(`${PLUGIN_NAME}-doorbell`);
      staleUuids.delete(uuid);

      let accessory = this.cachedAccessories.find((a) => a.UUID === uuid);
      const isNew = !accessory;
      if (!accessory) {
        accessory = new this.api.platformAccessory(
          this.platformConfig.name || 'Comelit Doorbell',
          uuid,
        );
      }

      this.doorbellAccessory = new DoorbellAccessory(this, accessory);

      if (isNew) {
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        this.log.info('Registered doorbell');
      } else {
        this.api.updatePlatformAccessories([accessory]);
      }
    }

    // RTSP cameras from device config (if any)
    for (const camera of config.cameras) {
      const uuid = this.api.hap.uuid.generate(`${PLUGIN_NAME}-camera-${camera.id}`);
      staleUuids.delete(uuid);

      let accessory = this.cachedAccessories.find((a) => a.UUID === uuid);
      const isNew = !accessory;
      if (!accessory) {
        accessory = new this.api.platformAccessory(camera.name || `Camera ${camera.id}`, uuid);
        accessory.context.camera = camera;
      }

      const camAcc = new CameraAccessory(this, accessory, camera);
      this.cameraAccessories.set(uuid, camAcc);

      if (isNew) {
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        this.log.info(`Registered camera: ${camera.name}`);
      } else {
        this.api.updatePlatformAccessories([accessory]);
      }
    }

    // Remove accessories that no longer exist
    const toRemove = this.cachedAccessories.filter((a) => staleUuids.has(a.UUID));
    if (toRemove.length > 0) {
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, toRemove);
      this.log.info(`Removed ${toRemove.length} stale accessory/accessories`);
    }
  }
}
