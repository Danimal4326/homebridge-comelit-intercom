"""Unit tests for VideoCallSession — no device needed."""

from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from custom_components.comelit_intercom_local.exceptions import VideoCallError
from custom_components.comelit_intercom_local.video_call import (
    VideoCallSession,
    _CTR_INCR_BOTH,
    _CTR_INCR_BYTE4,
    _CTR_INCR_BYTE5,
)


class TestCounterIncrementConstants:
    def test_ctr_incr_both_equals_byte4_plus_byte5(self):
        assert _CTR_INCR_BOTH == _CTR_INCR_BYTE4 + _CTR_INCR_BYTE5

    def test_ctr_incr_byte4_is_correct(self):
        assert _CTR_INCR_BYTE4 == 0x00010000

    def test_ctr_incr_byte5_is_correct(self):
        assert _CTR_INCR_BYTE5 == 0x01000000


class TestCleanup:
    @pytest.mark.asyncio
    async def test_cleanup_called_even_when_rtp_receiver_stop_raises(self):
        """_cleanup must still disconnect the client even if rtp_receiver.stop() raises."""
        session = VideoCallSession.__new__(VideoCallSession)
        session._active = True
        session._timeout_task = None
        session._tcp_task = None

        mock_receiver = MagicMock()
        mock_receiver.stop = AsyncMock(side_effect=RuntimeError("stop failed"))
        session._rtp_receiver = mock_receiver

        mock_client = MagicMock()
        mock_client.disconnect = AsyncMock()
        session._client = mock_client

        # Should not raise
        await session._cleanup()

        mock_client.disconnect.assert_awaited_once()
        assert session._active is False
        assert session._rtp_receiver is None
        assert session._client is None

    @pytest.mark.asyncio
    async def test_cleanup_cancels_timeout_task(self):
        """_cleanup must cancel the timeout task."""
        session = VideoCallSession.__new__(VideoCallSession)
        session._active = True
        session._rtp_receiver = None
        session._client = None
        session._tcp_task = None

        cancelled = asyncio.Event()

        async def long_task():
            try:
                await asyncio.sleep(100)
            except asyncio.CancelledError:
                cancelled.set()
                raise

        session._timeout_task = asyncio.create_task(long_task())
        await asyncio.sleep(0)  # let the task start before cleanup cancels it

        await session._cleanup()

        assert cancelled.is_set()
        assert session._timeout_task is None

    @pytest.mark.asyncio
    async def test_cleanup_is_idempotent(self):
        """Calling _cleanup twice must not raise."""
        session = VideoCallSession.__new__(VideoCallSession)
        session._active = True
        session._timeout_task = None
        session._tcp_task = None
        session._rtp_receiver = None
        session._client = None

        await session._cleanup()
        await session._cleanup()  # should not raise
