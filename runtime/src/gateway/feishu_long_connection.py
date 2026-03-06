"""Feishu long-connection supervisor (SDK WS client subprocess manager)."""

from __future__ import annotations

import asyncio
import contextlib
import logging
import os
from collections.abc import Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from src.gateway.manager import GatewayManager

logger = logging.getLogger(__name__)


@dataclass(slots=True)
class FeishuLongConnectionSupervisor:
    gateway_manager: GatewayManager
    runtime_base_url: str
    internal_token: str
    poll_interval_seconds: float = 5.0
    node_bin: str = field(default_factory=lambda: str(os.getenv("SEMIBOT_NODE_BIN", "node")).strip() or "node")
    _procs: dict[str, asyncio.subprocess.Process] = field(default_factory=dict)
    _drain_tasks: dict[str, asyncio.Task[None]] = field(default_factory=dict)
    _running: bool = False

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
        for instance_id in list(self._procs.keys()):
            await self._stop_instance(instance_id)

    async def _reconcile(self) -> None:
        desired = self._desired_instances()

        for instance_id in list(self._procs.keys()):
            if instance_id not in desired:
                await self._stop_instance(instance_id)

        for instance_id, spec in desired.items():
            proc = self._procs.get(instance_id)
            if proc and proc.returncode is None:
                continue
            if proc and proc.returncode is not None:
                await self._stop_instance(instance_id)
            await self._start_instance(spec)

    def _desired_instances(self) -> dict[str, dict[str, str]]:
        items = self.gateway_manager.list_provider_instances("feishu", active_only=True)
        desired: dict[str, dict[str, str]] = {}
        for item in items:
            mode = str(item.get("mode") or "").strip().lower()
            if mode not in {"long_connection", "longconn"}:
                continue
            cfg = item.get("config")
            cfg_map = cfg if isinstance(cfg, dict) else {}
            sdk_enabled = self.gateway_manager._to_bool(cfg_map.get("sdkEnabled"), False)  # noqa: SLF001
            app_id = str(cfg_map.get("appId") or "").strip()
            app_secret = str(cfg_map.get("appSecret") or "").strip()
            if not (sdk_enabled and app_id and app_secret):
                continue
            instance_id = str(item.get("id") or "").strip()
            if not instance_id:
                continue
            desired[instance_id] = {
                "instance_id": instance_id,
                "app_id": app_id,
                "app_secret": app_secret,
                "domain": str(cfg_map.get("sdkDomain") or "feishu").strip().lower() or "feishu",
            }
        return desired

    async def _start_instance(self, spec: Mapping[str, str]) -> None:
        runtime_root = Path(__file__).resolve().parents[2]
        script_path = runtime_root / "scripts" / "feishu_longconn_bridge.mjs"
        if not script_path.exists():
            logger.error("feishu long-connection bridge script not found: %s", script_path)
            return
        instance_id = spec["instance_id"]
        cmd = [
            self.node_bin,
            str(script_path),
            "--runtime-url",
            self.runtime_base_url,
            "--instance-id",
            instance_id,
            "--app-id",
            spec["app_id"],
            "--app-secret",
            spec["app_secret"],
            "--domain",
            spec["domain"],
            "--internal-token",
            self.internal_token,
        ]
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        self._procs[instance_id] = proc
        self._drain_tasks[instance_id] = asyncio.create_task(self._drain_logs(instance_id, proc))
        logger.info("started feishu long-connection bridge instance=%s pid=%s", instance_id, proc.pid)

    async def _stop_instance(self, instance_id: str) -> None:
        drain_task = self._drain_tasks.pop(instance_id, None)
        proc = self._procs.pop(instance_id, None)
        if proc and proc.returncode is None:
            proc.terminate()
            try:
                await asyncio.wait_for(proc.wait(), timeout=3.0)
            except TimeoutError:
                proc.kill()
                with contextlib.suppress(Exception):
                    await proc.wait()
        if drain_task:
            drain_task.cancel()
            with contextlib.suppress(Exception):
                await drain_task
        logger.info("stopped feishu long-connection bridge instance=%s", instance_id)

    async def _drain_logs(self, instance_id: str, proc: asyncio.subprocess.Process) -> None:
        async def _read_stream(stream: asyncio.StreamReader | None, level: str) -> None:
            if not stream:
                return
            while True:
                line = await stream.readline()
                if not line:
                    break
                text = line.decode("utf-8", errors="ignore").strip()
                if not text:
                    continue
                if level == "error":
                    logger.warning("feishu-bridge[%s] %s", instance_id, text)
                else:
                    logger.info("feishu-bridge[%s] %s", instance_id, text)

        await asyncio.gather(
            _read_stream(proc.stdout, "info"),
            _read_stream(proc.stderr, "error"),
        )
