import { ChannelState, ChannelType } from './channels';
import { IconaBridgeClient } from './client';
import { ctppInitSequence } from './ctpp';
import { DeviceConfig, Door } from './models';
import {
  MessageType,
  encodeActuatorInit,
  encodeActuatorOpen,
  encodeDoorInit,
  encodeOpenDoor,
} from './protocol';

const DOOR_CTPP_INIT_TIMEOUT_MS = 5_000;
const DOOR_RESPONSE_TIMEOUT_MS = 2_000;

export class DoorOpenError extends Error {}

export async function openDoor(
  client: IconaBridgeClient,
  config: DeviceConfig,
  door: Door,
): Promise<void> {
  const existingCtpp = client.getChannel('CTPP');
  const openedChannel = existingCtpp === undefined;

  let ctpp: ChannelState;
  if (existingCtpp) {
    ctpp = existingCtpp;
  } else {
    ctpp = await openCtppChannel(client, config);
  }

  try {
    await openDoorOnChannel(client, ctpp, config.aptAddress, door);
  } catch (e) {
    throw new DoorOpenError(`Failed to open door '${door.name}': ${(e as Error).message}`);
  } finally {
    if (openedChannel) {
      client.removeChannel('CTPP_DOOR');
    }
  }
}

export async function openCtppChannel(
  client: IconaBridgeClient,
  config: DeviceConfig,
): Promise<ChannelState> {
  const aptAddr = config.aptAddress;
  const aptSub = config.aptSubaddress;
  const ourAddr = `${aptAddr}${aptSub}`;

  try {
    const ctpp = await client.openChannel('CTPP_DOOR', ChannelType.CTPP, ourAddr);
    const ts = Date.now() / 1000 | 0;
    await ctppInitSequence(
      client, ctpp, aptAddr, aptSub, ourAddr, ts,
      DOOR_CTPP_INIT_TIMEOUT_MS,
      false, // no ACK pair for standalone door open
    );
    return ctpp;
  } catch (e) {
    throw new DoorOpenError(`Failed to open CTPP channel: ${(e as Error).message}`);
  }
}

async function openDoorOnChannel(
  client: IconaBridgeClient,
  channel: ChannelState,
  aptAddr: string,
  door: Door,
): Promise<void> {
  // Phase B: Open + Confirm (regular doors only)
  if (!door.isActuator) {
    await sendOpenAndConfirm(client, channel, aptAddr, door);
  }

  // Phase C: Door-specific init
  const initMsg = door.isActuator
    ? encodeActuatorInit(aptAddr, door.outputIndex, door.aptAddress)
    : encodeDoorInit(aptAddr, door.outputIndex, door.aptAddress);
  await client.sendBinary(channel, initMsg);

  for (let i = 0; i < 2; i++) {
    await client.readResponse(channel, DOOR_RESPONSE_TIMEOUT_MS);
  }

  // Phase D: Open + Confirm again
  if (!door.isActuator) {
    await sendOpenAndConfirm(client, channel, aptAddr, door);
  } else {
    await client.sendBinary(channel, encodeActuatorOpen(aptAddr, door.outputIndex, door.aptAddress, false));
    await client.sendBinary(channel, encodeActuatorOpen(aptAddr, door.outputIndex, door.aptAddress, true));
  }
}

async function sendOpenAndConfirm(
  client: IconaBridgeClient,
  channel: ChannelState,
  aptAddr: string,
  door: Door,
): Promise<void> {
  await client.sendBinary(
    channel,
    encodeOpenDoor(MessageType.OPEN_DOOR, aptAddr, door.outputIndex, door.aptAddress),
  );
  await client.sendBinary(
    channel,
    encodeOpenDoor(MessageType.OPEN_DOOR_CONFIRM, aptAddr, door.outputIndex, door.aptAddress),
  );
}
