"""Comelit Local integration for Home Assistant."""

from __future__ import annotations

import asyncio
import logging

from homeassistant.const import CONF_HOST, CONF_PORT, CONF_TOKEN, Platform
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import ConfigEntryAuthFailed, ConfigEntryNotReady

from .const import DEFAULT_PORT
from .coordinator import ComelitLocalConfigEntry, ComelitLocalCoordinator
from .exceptions import (
    AuthenticationError,
    ConnectionComelitError as ComelitConnectionError,
)

_LOGGER = logging.getLogger(__name__)

PLATFORMS = [Platform.BUTTON, Platform.CAMERA, Platform.EVENT]


async def async_setup_entry(
    hass: HomeAssistant, entry: ComelitLocalConfigEntry
) -> bool:
    """Set up Comelit Local from a config entry."""
    coordinator = ComelitLocalCoordinator(
        hass,
        entry,
        host=entry.data[CONF_HOST],
        port=entry.data.get(CONF_PORT, DEFAULT_PORT),
        token=entry.data[CONF_TOKEN],
    )

    try:
        await coordinator.async_setup()
    except AuthenticationError as err:
        raise ConfigEntryAuthFailed(
            f"Authentication failed for Comelit device: {err}"
        ) from err
    except (TimeoutError, ComelitConnectionError, OSError) as err:
        raise ConfigEntryNotReady(
            f"Failed to connect to Comelit device: {err}"
        ) from err
    except Exception as err:
        raise ConfigEntryNotReady(
            f"Unexpected error setting up Comelit device: {err}"
        ) from err

    entry.runtime_data = coordinator

    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    return True


async def async_unload_entry(
    hass: HomeAssistant, entry: ComelitLocalConfigEntry
) -> bool:
    """Unload a config entry."""
    unload_ok = await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
    if unload_ok:
        await entry.runtime_data.async_shutdown()
    return unload_ok
