import { IconaBridgeClient, ProtocolError } from './client';
import { ChannelType, ViperMessageId } from './channels';
import { Camera, DeviceConfig, Door } from './models';

export async function getDeviceConfig(client: IconaBridgeClient): Promise<DeviceConfig> {
  const channel = await client.openChannel('UCFG', ChannelType.UCFG);

  const response = await client.sendJson(channel, {
    message: 'get-configuration',
    addressbooks: 'all',
    'message-type': 'request',
    'message-id': ViperMessageId.UCFG,
  });

  const code = response['response-code'] as number | undefined;
  if (code !== 200) throw new ProtocolError(`Config request returned code ${code}`);

  return parseConfig(response);
}

function parseConfig(data: Record<string, unknown>): DeviceConfig {
  const config: DeviceConfig = {
    aptAddress: '',
    aptSubaddress: 0,
    callerAddress: '',
    doors: [],
    cameras: [],
    raw: data,
  };

  const vip = (data['vip'] ?? {}) as Record<string, unknown>;
  config.aptAddress = (vip['apt-address'] as string | undefined) ?? '';
  config.aptSubaddress = (vip['apt-subaddress'] as number | undefined) ?? 0;

  const userParams = (vip['user-parameters'] ?? {}) as Record<string, unknown>;

  const entranceBook = (userParams['entrance-address-book'] as unknown[] | undefined) ?? [];
  if (entranceBook.length > 0) {
    config.callerAddress = ((entranceBook[0] as Record<string, unknown>)['apt-address'] as string | undefined) ?? '';
  }

  let doorIndex = 0;
  const doorBook = (userParams['opendoor-address-book'] as unknown[] | undefined) ?? [];
  for (const item of doorBook) {
    const d = item as Record<string, unknown>;
    config.doors.push({
      id: (d['id'] as number | undefined) ?? doorIndex,
      index: doorIndex,
      name: (d['name'] as string | undefined) ?? '',
      aptAddress: (d['apt-address'] as string | undefined) ?? '',
      outputIndex: (d['output-index'] as number | undefined) ?? 0,
      secureMode: (d['secure-mode'] as boolean | undefined) ?? false,
      isActuator: false,
      moduleIndex: 0,
    } satisfies Door);
    doorIndex++;
  }

  const actuatorBook = (userParams['actuator-address-book'] as unknown[] | undefined) ?? [];
  for (const item of actuatorBook) {
    const d = item as Record<string, unknown>;
    config.doors.push({
      id: (d['id'] as number | undefined) ?? doorIndex,
      index: doorIndex,
      name: (d['name'] as string | undefined) ?? '',
      aptAddress: (d['apt-address'] as string | undefined) ?? '',
      outputIndex: (d['output-index'] as number | undefined) ?? 0,
      secureMode: (d['secure-mode'] as boolean | undefined) ?? false,
      isActuator: true,
      moduleIndex: (d['module-index'] as number | undefined) ?? 0,
    } satisfies Door);
    doorIndex++;
  }

  const cameraBook = (userParams['rtsp-camera-address-book'] as unknown[] | undefined) ?? [];
  for (const item of cameraBook) {
    const c = item as Record<string, unknown>;
    config.cameras.push({
      id: (c['id'] as number | undefined) ?? 0,
      name: (c['name'] as string | undefined) ?? '',
      rtspUrl: (c['rtsp-url'] as string | undefined) ?? '',
      rtspUser: (c['rtsp-user'] as string | undefined) ?? '',
      rtspPassword: (c['rtsp-password'] as string | undefined) ?? '',
    } satisfies Camera);
  }

  return config;
}
