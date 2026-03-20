"""Telegram long-polling connection supervisor.

Pure-Python implementation that calls ``getUpdates`` in a loop and forwards
each update to the runtime internal webhook endpoint, reusing the existing
ingestion pipeline (``ingest_webhook``).

Unlike Discord/Feishu supervisors that spawn Node.js subprocesses, this
supervisor runs entirely in-process because the Telegram Bot API is plain
HTTP — no WebSocket or SDK dependency required.
"""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

import httpx

if TYPE_CHECKING:
    from src.gateway.manager import GatewayManager

logger = logging.getLogger(__name__)

_TELEGRAM_API = "https://api.telegram.org"
_GET_UPDATES_TIMEOUT = 30  # Telegram long-poll timeout (seconds)
_POLL_ERROR_BACKOFF = 5.0  # Backoff after transient errors
_RECONCILE_INTERVAL = 5.0  # How often to reconcile desired vs running instances


@dataclass(slots=True)
class _InstanceState:
    """Tracks a single polling instance (one bot token)."""

    instance_id: str
    bot_token: str
    offset: int = 0
    task: asyncio.Task[None] | None = None


@dataclass(slots=True)
class TelegramPollingConnectionSupervisor:
    """Reconciliation-based supervisor that manages per-instance polling loops."""

    gateway_manager: GatewayManager
    runtime_base_url: str
    internal_token: str
    poll_interval_seconds: float = _RECONCILE_INTERVAL
    _instances: dict[str, _InstanceState] = field(default_factory=dict)
    _running: bool = False
    _http: httpx.AsyncClient | None = field(default=None, repr=False)

    # ------------------------------------------------------------------
    # Public lifecycle
    # ------------------------------------------------------------------

    async def run(self) -> None:
        self._running = True
        self._http = httpx.AsyncClient(timeout=httpx.Timeout(_GET_UPDATES_TIMEOUT + 10, connect=10))
        try:
            while self._running:
                await self._reconcile()
                await asyncio.sleep(self.poll_interval_seconds)
        finally:
            await self.stop()

    async def stop(self) -> None:
        self._running = False
        for instance_id in list(self._instances):
            await self._stop_instance(instance_id)
        if self._http:
            await self._http.aclose()
            self._http = None

    # ------------------------------------------------------------------
    # Reconciliation (desired state vs running tasks)
    # ------------------------------------------------------------------

    async def _reconcile(self) -> None:
        desired = self._desired_instances()
        # Stop instances no longer desired
        for instance_id in list(self._instances):
            if instance_id not in desired:
                await self._stop_instance(instance_id)
        # Start or restart instances
        for instance_id, spec in desired.items():
            existing = self._instances.get(instance_id)
            if existing and existing.task and not existing.task.done():
                continue
            if existing and existing.task and existing.task.done():
                await self._stop_instance(instance_id)
            self._start_instance(spec)

    def _desired_instances(self) -> dict[str, dict[str, str]]:
        items = self.gateway_manager.list_provider_instances("telegram", active_only=True)
        desired: dict[str, dict[str, str]] = {}
        for item in items:
            mode = str(item.get("mode") or "").strip().lower()
            if mode not in {"polling", "long_polling", "getUpdates", "getupdates"}:
                continue
            cfg = item.get("config")
            cfg_map = cfg if isinstance(cfg, dict) else {}
            bot_token = str(cfg_map.get("botToken") or "").strip()
            instance_id = str(item.get("id") or "").strip()
            if not instance_id or not bot_token:
                continue
            desired[instance_id] = {"instance_id": instance_id, "bot_token": bot_token}
        return desired

    # ------------------------------------------------------------------
    # Instance lifecycle
    # ------------------------------------------------------------------

    def _start_instance(self, spec: dict[str, str]) -> None:
        instance_id = spec["instance_id"]
        state = _InstanceState(
            instance_id=instance_id,
            bot_token=spec["bot_token"],
        )
        state.task = asyncio.create_task(
            self._poll_loop(state),
            name=f"tg-poll-{instance_id}",
        )
        self._instances[instance_id] = state
        logger.info("started telegram polling instance=%s", instance_id)

    async def _stop_instance(self, instance_id: str) -> None:
        state = self._instances.pop(instance_id, None)
        if not state:
            return
        if state.task and not state.task.done():
            state.task.cancel()
            try:
                await state.task
            except (asyncio.CancelledError, Exception):
                pass
        # Delete webhook to ensure clean state (getUpdates requires no active webhook)
        if self._http:
            try:
                await self._http.post(
                    f"{_TELEGRAM_API}/bot{state.bot_token}/deleteWebhook",
                )
            except Exception:
                pass
        logger.info("stopped telegram polling instance=%s", instance_id)

    # ------------------------------------------------------------------
    # Polling loop (one per instance)
    # ------------------------------------------------------------------

    async def _poll_loop(self, state: _InstanceState) -> None:
        """Long-poll ``getUpdates`` and forward each update to the internal endpoint."""
        http = self._http
        if not http:
            return
        # Clear any existing webhook before starting polling
        try:
            await http.post(f"{_TELEGRAM_API}/bot{state.bot_token}/deleteWebhook")
        except Exception as exc:
            logger.warning("telegram polling: failed to delete webhook instance=%s: %s", state.instance_id, exc)

        while self._running:
            try:
                resp = await http.get(
                    f"{_TELEGRAM_API}/bot{state.bot_token}/getUpdates",
                    params={
                        "offset": state.offset,
                        "timeout": _GET_UPDATES_TIMEOUT,
                        "allowed_updates": '["message","edited_message","callback_query"]',
                    },
                )
                if resp.status_code != 200:
                    logger.warning(
                        "telegram getUpdates non-200 instance=%s status=%s",
                        state.instance_id, resp.status_code,
                    )
                    await asyncio.sleep(_POLL_ERROR_BACKOFF)
                    continue
                body = resp.json()
                updates = body.get("result") if isinstance(body.get("result"), list) else []
                for update in updates:
                    if not isinstance(update, dict):
                        continue
                    update_id = update.get("update_id")
                    if isinstance(update_id, int):
                        state.offset = update_id + 1
                    await self._forward_update(state, update)
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                logger.warning(
                    "telegram polling error instance=%s: %s",
                    state.instance_id, exc,
                )
                await asyncio.sleep(_POLL_ERROR_BACKOFF)

    # ------------------------------------------------------------------
    # Forward update to internal webhook endpoint
    # ------------------------------------------------------------------

    async def _forward_update(self, state: _InstanceState, update: dict[str, Any]) -> None:
        """POST the raw Telegram update to the runtime internal endpoint."""
        http = self._http
        if not http:
            return
        url = f"{self.runtime_base_url}/v1/integrations/telegram/events/internal"
        try:
            resp = await http.post(
                url,
                json=update,
                headers={
                    "x-semibot-internal-token": self.internal_token,
                    "x-semibot-instance-id": state.instance_id,
                },
                timeout=httpx.Timeout(30, connect=10),
            )
            if resp.status_code >= 400:
                logger.warning(
                    "telegram forward failed instance=%s status=%s body=%s",
                    state.instance_id, resp.status_code, resp.text[:200],
                )
        except Exception as exc:
            logger.warning(
                "telegram forward error instance=%s: %s",
                state.instance_id, exc,
            )
