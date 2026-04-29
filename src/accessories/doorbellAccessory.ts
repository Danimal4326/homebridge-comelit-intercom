import { PlatformAccessory, Service } from 'homebridge';
import { ComelitIntercomPlatform } from '../platform';

const RING_DURATION_MS = 5_000;

export class DoorbellAccessory {
  private readonly switchService: Service;
  private active = false;
  private offTimer?: NodeJS.Timeout;

  constructor(
    private readonly platform: ComelitIntercomPlatform,
    private readonly accessory: PlatformAccessory,
  ) {
    const { Service, Characteristic } = platform;

    accessory
      .getService(Service.AccessoryInformation)!
      .setCharacteristic(Characteristic.Manufacturer, 'Comelit')
      .setCharacteristic(Characteristic.Model, '6701W')
      .setCharacteristic(Characteristic.SerialNumber, 'doorbell');

    // Remove stale services from previous versions
    for (const stale of [Service.Doorbell, Service.Speaker]) {
      const svc = accessory.getService(stale);
      if (svc) accessory.removeService(svc);
    }

    this.switchService =
      accessory.getService(Service.Switch) ||
      accessory.addService(Service.Switch, accessory.displayName);

    this.switchService
      .getCharacteristic(Characteristic.On)
      .onGet(() => this.active)
      .onSet((value) => {
        if (!value) this._setOff();
      });
  }

  /** Called by the platform when a doorbell_ring VIP event arrives. */
  triggerRing(): void {
    this.platform.log.info('Doorbell ring');
    this.active = true;
    this.switchService
      .getCharacteristic(this.platform.Characteristic.On)
      .updateValue(true);

    clearTimeout(this.offTimer);
    this.offTimer = setTimeout(() => this._setOff(), RING_DURATION_MS);
  }

  private _setOff(): void {
    this.active = false;
    this.switchService
      .getCharacteristic(this.platform.Characteristic.On)
      .updateValue(false);
  }
}
