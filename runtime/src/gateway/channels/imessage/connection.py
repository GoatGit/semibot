"""iMessage connection supervisor skeleton.

Design target: BlueBubbles bridge lifecycle managed by gateway.
Current scope: discover desired instances and health-check bridge endpoints.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
import contextlib
from typing import TYPE_CHECKING

import httpx

if TYPE_CHECKING:
    from src.gateway.manager import GatewayManager


@dataclass(slots=True)
class IMessageConnectionSupervisor:
    gateway_manager: GatewayManager
    runtime_base_url: str
    internal_token: str
    poll_interval_seconds: float = 5.0
    _running: bool = False
    _healthy: dict[str, bool] = None  # type: ignore[assignment]

    def __post_init__(self) -> None:
        self._healthy = {}

    async def run(self) -> None:
        self._running = True
        try:
            while self._running:
                await self._reconcile()
                await asyncio.sleep(self.poll_interval_seconds)
        finally:
            await self.stop()

    async def stop(self) -> None:
        self._running = False

    def _desired_instances(self) -> list[dict[str, str]]:
        items = self.gateway_manager.list_provider_instances("imessage", active_only=True)
        desired: list[dict[str, str]] = []
        for item in items:
            cfg = item.get("config")
            cfg_map = cfg if isinstance(cfg, dict) else {}
            mode = str(item.get("mode") or "").strip().lower()
            bridge_url = str(cfg_map.get("bridgeUrl") or "").strip()
            if mode not in {"gateway", "bridge", "bluebubbles"}:
                continue
            if not bridge_url:
                continue
            desired.append({"instance_id": str(item.get("id") or "").strip(), "bridge_url": bridge_url})
        return desired

    async def _reconcile(self) -> None:
        desired = self._desired_instances()
        for spec in desired:
            instance_id = spec["instance_id"]
            bridge_url = spec["bridge_url"]
            self._healthy[instance_id] = await self._check_health(bridge_url)

    async def _check_health(self, bridge_url: str) -> bool:
        timeout = httpx.Timeout(5.0, connect=3.0)
        async with httpx.AsyncClient(timeout=timeout) as client:
            for path in ("/health", "/api/health"):
                with contextlib.suppress(httpx.HTTPError):
                    response = await client.get(f"{bridge_url.rstrip('/')}{path}")
                    if response.status_code < 500:
                        return True
        return False
