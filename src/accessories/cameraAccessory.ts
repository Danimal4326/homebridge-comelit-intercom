import { PlatformAccessory, Service } from 'homebridge';
import { ComelitIntercomPlatform } from '../platform';
import { Camera } from '../models';

/**
 * CameraAccessory — exposes an RTSP camera from the device config.
 *
 * Full HomeKit camera streaming requires a CameraController + streaming
 * delegate (FFmpeg) and is out of scope for the initial plugin version.
 * This accessory registers the camera in HomeKit so it appears in the
 * Home app; a future update will add live streaming support.
 */
export class CameraAccessory {
  private readonly service: Service;

  constructor(
    private readonly platform: ComelitIntercomPlatform,
    private readonly accessory: PlatformAccessory,
    private readonly camera: Camera,
  ) {
    const { Service, Characteristic } = platform;

    accessory
      .getService(Service.AccessoryInformation)!
      .setCharacteristic(Characteristic.Manufacturer, 'Comelit')
      .setCharacteristic(Characteristic.Model, 'IP Camera')
      .setCharacteristic(Characteristic.SerialNumber, `cam-${camera.id}`)
      .setCharacteristic(Characteristic.Name, camera.name);

    // Motion sensor as a proxy until full camera streaming is implemented
    this.service =
      accessory.getService(Service.MotionSensor) ||
      accessory.addService(Service.MotionSensor, camera.name);

    this.service
      .getCharacteristic(Characteristic.MotionDetected)
      .onGet(() => false);

    if (camera.rtspUrl) {
      platform.log.info(
        `Camera '${camera.name}' RTSP URL: ${camera.rtspUrl} (streaming not yet implemented)`,
      );
    }
  }
}
