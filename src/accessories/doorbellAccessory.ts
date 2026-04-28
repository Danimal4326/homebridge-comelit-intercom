import { PlatformAccessory, Service } from 'homebridge';
import { ComelitIntercomPlatform } from '../platform';

/**
 * DoorbellAccessory — fires a HAP Doorbell event when the intercom rings.
 *
 * Uses Service.Doorbell with ProgrammableSwitchEvent (SINGLE_PRESS = ring).
 * HomeKit sends a notification to all registered devices when triggered.
 */
export class DoorbellAccessory {
  private readonly doorbellService: Service;
  private readonly speakerService: Service;

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

    this.doorbellService =
      accessory.getService(Service.Doorbell) ||
      accessory.addService(Service.Doorbell, accessory.displayName);

    // ProgrammableSwitchEvent is required by HAP for Doorbell — set read-only
    this.doorbellService
      .getCharacteristic(Characteristic.ProgrammableSwitchEvent)
      .onGet(() => null);

    // Speaker service is required by HAP for video doorbell accessories
    this.speakerService =
      accessory.getService(Service.Speaker) ||
      accessory.addService(Service.Speaker, 'Speaker');

    this.speakerService
      .getCharacteristic(Characteristic.Mute)
      .onGet(() => false)
      .onSet(() => { /* no-op */ });
  }

  /** Called by the platform when a doorbell_ring VIP event arrives. */
  triggerRing(): void {
    const { Characteristic } = this.platform;
    this.platform.log.info('Doorbell ring → triggering HAP event');
    this.doorbellService
      .getCharacteristic(Characteristic.ProgrammableSwitchEvent)
      .updateValue(Characteristic.ProgrammableSwitchEvent.SINGLE_PRESS);
  }
}
