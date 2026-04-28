import { PlatformAccessory, Service } from 'homebridge';
import { ComelitIntercomPlatform } from '../platform';
import { Door } from '../models';

/**
 * LockAccessory — represents one door relay as a HAP LockMechanism.
 *
 * HomeKit shows it as "Secured". When the user presses Open, the
 * characteristic briefly transitions to Unsecured, the door relay fires,
 * then it auto-returns to Secured after 3 s.
 */
export class LockAccessory {
  private readonly service: Service;
  private lockState: number;

  constructor(
    private readonly platform: ComelitIntercomPlatform,
    private readonly accessory: PlatformAccessory,
    private readonly door: Door,
  ) {
    const { Service, Characteristic } = platform;
    const SECURED = Characteristic.LockCurrentState.SECURED;
    const UNSECURED = Characteristic.LockCurrentState.UNSECURED;

    this.lockState = SECURED;

    accessory
      .getService(Service.AccessoryInformation)!
      .setCharacteristic(Characteristic.Manufacturer, 'Comelit')
      .setCharacteristic(Characteristic.Model, '6701W')
      .setCharacteristic(Characteristic.SerialNumber, `door-${door.index}`);

    this.service =
      accessory.getService(Service.LockMechanism) ||
      accessory.addService(Service.LockMechanism, door.name);

    this.service
      .getCharacteristic(Characteristic.LockCurrentState)
      .onGet(() => this.lockState);

    this.service
      .getCharacteristic(Characteristic.LockTargetState)
      .onGet(() =>
        this.lockState === UNSECURED
          ? Characteristic.LockTargetState.UNSECURED
          : Characteristic.LockTargetState.SECURED,
      )
      .onSet(async (value) => {
        if (value === Characteristic.LockTargetState.UNSECURED) {
          await this.triggerOpen();
        }
      });
  }

  private async triggerOpen(): Promise<void> {
    const { Characteristic } = this.platform;
    const SECURED = Characteristic.LockCurrentState.SECURED;
    const UNSECURED = Characteristic.LockCurrentState.UNSECURED;

    this.lockState = UNSECURED;
    this.service.updateCharacteristic(Characteristic.LockCurrentState, UNSECURED);

    try {
      await this.platform.openDoor(this.door);
      this.platform.log.info(`Door '${this.door.name}' opened`);
    } catch (e) {
      this.platform.log.error(`Door open failed: ${(e as Error).message}`);
    }

    // Auto-secure after 3 s regardless of success
    setTimeout(() => {
      this.lockState = SECURED;
      this.service.updateCharacteristic(Characteristic.LockCurrentState, SECURED);
      this.service.updateCharacteristic(
        Characteristic.LockTargetState,
        Characteristic.LockTargetState.SECURED,
      );
    }, 3_000);
  }

  onDisconnect(): void {
    // Could set to UNKNOWN if desired — leave as SECURED for now
  }
}
