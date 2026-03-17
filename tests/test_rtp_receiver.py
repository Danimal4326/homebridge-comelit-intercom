"""Unit tests for RtpReceiver — no device or PyAV needed."""

from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from custom_components.comelit_intercom_local.rtp_receiver import RtpReceiver


class TestRtpReceiverStop:
    @pytest.mark.asyncio
    async def test_stop_awaits_keepalive_task(self):
        """stop() must await the keepalive task, not just cancel it."""
        receiver = RtpReceiver("127.0.0.1")
        receiver._running = True

        cancelled = asyncio.Event()

        async def slow_keepalive():
            try:
                await asyncio.sleep(100)
            except asyncio.CancelledError:
                cancelled.set()
                raise

        receiver._keepalive_task = asyncio.create_task(slow_keepalive())
        await asyncio.sleep(0)  # let the task start before cancelling

        await receiver.stop()

        assert cancelled.is_set(), "keepalive task was not properly awaited/cancelled"
        assert receiver._keepalive_task is None

    @pytest.mark.asyncio
    async def test_stop_awaits_decode_task(self):
        """stop() must await the decode task, not just cancel it."""
        receiver = RtpReceiver("127.0.0.1")
        receiver._running = True

        cancelled = asyncio.Event()

        async def slow_decode():
            try:
                await asyncio.sleep(100)
            except asyncio.CancelledError:
                cancelled.set()
                raise

        receiver._decode_task = asyncio.create_task(slow_decode())
        await asyncio.sleep(0)  # let the task start before cancelling

        await receiver.stop()

        assert cancelled.is_set(), "decode task was not properly awaited/cancelled"
        assert receiver._decode_task is None

    @pytest.mark.asyncio
    async def test_stop_sets_running_false(self):
        receiver = RtpReceiver("127.0.0.1")
        receiver._running = True
        await receiver.stop()
        assert not receiver._running

    @pytest.mark.asyncio
    async def test_running_property(self):
        receiver = RtpReceiver("127.0.0.1")
        assert not receiver.running
        receiver._running = True
        assert receiver.running
