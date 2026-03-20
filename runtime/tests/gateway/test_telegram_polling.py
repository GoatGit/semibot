"""Tests for Telegram long-polling connection supervisor."""

from __future__ import annotations

import asyncio
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from src.gateway.channels.telegram.polling import (
    TelegramPollingConnectionSupervisor,
    _InstanceState,
)


def _make_manager(instances: list[dict[str, Any]] | None = None) -> MagicMock:
    manager = MagicMock()
    manager.list_provider_instances.return_value = instances or []
    return manager


def _make_supervisor(
    manager: MagicMock | None = None,
    **kwargs: Any,
) -> TelegramPollingConnectionSupervisor:
    return TelegramPollingConnectionSupervisor(
        gateway_manager=manager or _make_manager(),
        runtime_base_url="http://localhost:9090",
        internal_token="test-token",
        **kwargs,
    )


# ---------------------------------------------------------------------------
# desired_instances
# ---------------------------------------------------------------------------


def test_desired_instances_filters_by_polling_mode() -> None:
    manager = _make_manager([
        {"id": "inst-1", "mode": "polling", "config": {"botToken": "tok1"}},
        {"id": "inst-2", "mode": "webhook", "config": {"botToken": "tok2"}},
        {"id": "inst-3", "mode": "long_polling", "config": {"botToken": "tok3"}},
    ])
    sup = _make_supervisor(manager)
    desired = sup._desired_instances()
    assert set(desired.keys()) == {"inst-1", "inst-3"}
    assert desired["inst-1"]["bot_token"] == "tok1"
    assert desired["inst-3"]["bot_token"] == "tok3"
def test_desired_instances_skips_missing_token() -> None:
    manager = _make_manager([
        {"id": "inst-1", "mode": "polling", "config": {"botToken": ""}},
        {"id": "inst-2", "mode": "polling", "config": {}},
        {"id": "inst-3", "mode": "polling", "config": {"botToken": "tok3"}},
    ])
    sup = _make_supervisor(manager)
    desired = sup._desired_instances()
    assert list(desired.keys()) == ["inst-3"]


def test_desired_instances_empty_when_no_instances() -> None:
    sup = _make_supervisor(_make_manager([]))
    assert sup._desired_instances() == {}


# ---------------------------------------------------------------------------
# reconcile
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_reconcile_starts_new_instance() -> None:
    manager = _make_manager([
        {"id": "inst-1", "mode": "polling", "config": {"botToken": "tok1"}},
    ])
    sup = _make_supervisor(manager)

    def fake_start(self_: Any, spec: dict[str, str]) -> None:
        self_._instances[spec["instance_id"]] = _InstanceState(
            instance_id=spec["instance_id"],
            bot_token=spec["bot_token"],
        )

    with patch.object(TelegramPollingConnectionSupervisor, "_start_instance", fake_start):
        await sup._reconcile()
    assert "inst-1" in sup._instances


@pytest.mark.asyncio
async def test_reconcile_stops_removed_instance() -> None:
    sup = _make_supervisor(_make_manager([]))
    # Pre-populate a running instance
    sup._instances["old-inst"] = _InstanceState(
        instance_id="old-inst",
        bot_token="tok",
    )
    await sup._reconcile()
    assert "old-inst" not in sup._instances


# ---------------------------------------------------------------------------
# forward_update
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_forward_update_posts_to_internal_endpoint() -> None:
    import httpx

    sup = _make_supervisor()
    mock_response = MagicMock()
    mock_response.status_code = 200
    mock_client = AsyncMock(spec=httpx.AsyncClient)
    mock_client.post.return_value = mock_response
    sup._http = mock_client

    state = _InstanceState(instance_id="inst-1", bot_token="tok1")
    update = {"update_id": 42, "message": {"text": "hello"}}
    await sup._forward_update(state, update)

    mock_client.post.assert_called_once()
    call_args = mock_client.post.call_args
    assert "/v1/integrations/telegram/events/internal" in call_args[0][0]
    assert call_args[1]["json"] == update
    assert call_args[1]["headers"]["x-semibot-internal-token"] == "test-token"
    assert call_args[1]["headers"]["x-semibot-instance-id"] == "inst-1"


# ---------------------------------------------------------------------------
# offset tracking
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_poll_loop_advances_offset() -> None:
    """Verify that offset is updated after processing updates."""
    import httpx

    sup = _make_supervisor()
    mock_client = AsyncMock(spec=httpx.AsyncClient)

    # First call returns updates, second raises CancelledError to stop loop
    get_response = MagicMock()
    get_response.status_code = 200
    get_response.json.return_value = {
        "ok": True,
        "result": [
            {"update_id": 100, "message": {"text": "a"}},
            {"update_id": 101, "message": {"text": "b"}},
        ],
    }
    post_response = MagicMock()
    post_response.status_code = 200

    call_count = 0

    async def mock_get(*args: Any, **kwargs: Any) -> Any:
        nonlocal call_count
        call_count += 1
        if call_count > 1:
            raise asyncio.CancelledError()
        return get_response

    mock_client.get = mock_get
    mock_client.post = AsyncMock(return_value=post_response)
    sup._http = mock_client
    sup._running = True

    state = _InstanceState(instance_id="inst-1", bot_token="tok1")
    with pytest.raises(asyncio.CancelledError):
        await sup._poll_loop(state)

    assert state.offset == 102  # 101 + 1


# ---------------------------------------------------------------------------
# stop
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_stop_cancels_running_tasks() -> None:
    import httpx

    sup = _make_supervisor()
    mock_client = AsyncMock(spec=httpx.AsyncClient)
    mock_client.post = AsyncMock(return_value=MagicMock(status_code=200))
    sup._http = mock_client

    # Create a dummy long-running task
    async def forever() -> None:
        await asyncio.sleep(3600)

    state = _InstanceState(instance_id="inst-1", bot_token="tok1")
    state.task = asyncio.create_task(forever())
    sup._instances["inst-1"] = state

    await sup.stop()
    assert "inst-1" not in sup._instances
    assert sup._running is False
