import { IconaBridgeClient } from './client';
import { ChannelType, ViperMessageId } from './channels';
import { DeviceConfig, PushEvent } from './models';

const BUNDLE_ID = 'com.comelitgroup.friendhome';
const PROFILE_ID = '3';
const DEVICE_TOKEN = 'comelit-local-homebridge-plugin';

function buildPushMsg(config: DeviceConfig): Record<string, unknown> {
  return {
    'apt-address': config.aptAddress,
    'apt-subaddress': config.aptSubaddress,
    'bundle-id': BUNDLE_ID,
    message: 'push-info',
    'message-id': ViperMessageId.PUSH,
    'os-type': 'ios',
    'profile-id': PROFILE_ID,
    'device-token': DEVICE_TOKEN,
    'message-type': 'request',
  };
}

export async function registerPush(
  client: IconaBridgeClient,
  config: DeviceConfig,
  callback: (event: PushEvent) => void,
): Promise<void> {
  const channel = await client.openChannel('PUSH', ChannelType.PUSH);
  await client.sendJson(channel, buildPushMsg(config));

  client.setPushCallback((raw) => {
    const event = parsePushEvent(raw);
    if (event) callback(event);
  });
}

export async function sendPushKeepalive(
  client: IconaBridgeClient,
  config: DeviceConfig,
): Promise<void> {
  const channel = client.getChannel('PUSH');
  if (!channel) throw new Error('PUSH channel not open');
  await client.sendJson(channel, buildPushMsg(config));
}

function parsePushEvent(raw: Record<string, unknown>): PushEvent | null {
  const msgType = raw['message'] as string | undefined;

  if (msgType === 'incoming-call' || msgType === 'push-incoming-call') {
    return {
      eventType: 'doorbell_ring',
      aptAddress: (raw['apt-address'] as string | undefined) ?? '',
      timestamp: Date.now() / 1000,
      raw,
    };
  }

  if (msgType === 'missed-call' || msgType === 'push-missed-call') {
    return {
      eventType: 'missed_call',
      aptAddress: (raw['apt-address'] as string | undefined) ?? '',
      timestamp: Date.now() / 1000,
      raw,
    };
  }

  return null;
}
