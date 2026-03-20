"""WhatsApp gateway supervisor (Baileys bridge subprocess manager)."""

from __future__ import annotations

import asyncio
import contextlib
import logging
import os
from collections.abc import Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING

from src.gateway.channels.whatsapp.helpers import auth_dir_for_instance, outbox_dir_for_instance

if TYPE_CHECKING:
    from src.gateway.manager import GatewayManager

logger = logging.getLogger(__name__)


@dataclass(slots=True)
class WhatsAppConnectionSupervisor:
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

    def _desired_instances(self) -> dict[str, dict[str, str]]:
        items = self.gateway_manager.list_provider_instances("whatsapp", active_only=True)
        desired: dict[str, dict[str, str]] = {}
        for item in items:
            cfg = item.get("config")
            cfg_map = cfg if isinstance(cfg, dict) else {}
            mode = str(item.get("mode") or "").strip().lower()
            session_name = str(cfg_map.get("sessionName") or "").strip()
            linked_phone = str(cfg_map.get("linkedPhone") or "").strip()
            instance_id = str(item.get("id") or "").strip()
            if mode not in {"gateway", "bridge", "baileys"}:
                continue
            if not instance_id or not session_name:
                continue
            desired[instance_id] = {
                "instance_id": instance_id,
                "session_name": session_name,
                "linked_phone": linked_phone,
                "auth_dir": str(auth_dir_for_instance(instance_id)),
                "outbox_dir": str(outbox_dir_for_instance(instance_id)),
            }
        return desired

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

    async def _start_instance(self, spec: Mapping[str, str]) -> None:
        runtime_root = Path(__file__).resolve().parents[4]
        script_path = runtime_root / "scripts" / "whatsapp_gateway_bridge.mjs"
        if not script_path.exists():
            logger.error("whatsapp gateway bridge script not found: %s", script_path)
            return
        instance_id = spec["instance_id"]
        cmd = [
            self.node_bin,
            str(script_path),
            "--runtime-url",
            self.runtime_base_url,
            "--instance-id",
            instance_id,
            "--session-name",
            spec["session_name"],
            "--auth-dir",
            spec["auth_dir"],
            "--outbox-dir",
            spec["outbox_dir"],
            "--internal-token",
            self.internal_token,
        ]
        if str(spec.get("linked_phone") or "").strip():
            cmd.extend(["--linked-phone", str(spec["linked_phone"])])
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        self._procs[instance_id] = proc
        self._drain_tasks[instance_id] = asyncio.create_task(self._drain_logs(instance_id, proc))
        logger.info("started whatsapp gateway bridge instance=%s pid=%s", instance_id, proc.pid)

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
        logger.info("stopped whatsapp gateway bridge instance=%s", instance_id)

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
                    logger.warning("whatsapp-bridge[%s] %s", instance_id, text)
                else:
                    logger.info("whatsapp-bridge[%s] %s", instance_id, text)

        await asyncio.gather(_read_stream(proc.stdout, "info"), _read_stream(proc.stderr, "error"))
