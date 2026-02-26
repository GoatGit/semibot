from __future__ import annotations

import asyncio
import os
import shutil
from typing import Any

from src.security.api_key_cipher import decrypt_api_keys
from src.session.openclaw_adapter import OpenClawBridgeAdapter
from src.session.runtime_adapter import RuntimeAdapter
from src.session.semigraph_adapter import SemiGraphAdapter
from src.utils.logging import get_logger
from src.ws.client import ControlPlaneClient

logger = get_logger(__name__)

SUPPORTED_RUNTIME_TYPES = {"semigraph", "openclaw"}


class SessionManager:
    def __init__(self, client: ControlPlaneClient, init_data: dict[str, Any]) -> None:
        self.client = client
        vm_token = os.getenv("VM_TOKEN", "")
        self.init_data = dict(init_data)
        self.init_data["api_keys"] = decrypt_api_keys(init_data.get("api_keys"), vm_token)
        self.user_id = str(init_data.get("user_id", "local"))
        self.org_id = str(init_data.get("org_id", "local"))
        self.adapters: dict[str, RuntimeAdapter] = {}
        self.session_ready_events: dict[str, asyncio.Event] = {}

        self.client.set_active_sessions_provider(self.get_active_sessions)

    async def start_session(self, data: dict[str, Any]) -> None:
        session_id = str(data.get("session_id", ""))
        if not session_id:
            return

        if session_id in self.adapters:
            return

        data = self._filter_skill_index_by_requirements(data)
        data = await self._enrich_skill_packages(session_id, data)

        runtime_type = str(data.get("runtime_type", "semigraph"))
        adapter = self._create_adapter(runtime_type, session_id, data)
        self.adapters[session_id] = adapter
        ready_event = asyncio.Event()
        self.session_ready_events[session_id] = ready_event

        self.client.register_session_handlers(
            session_id,
            user_message=lambda payload, sid=session_id: self._on_user_message(sid, payload),
            cancel=lambda payload, sid=session_id: self._on_cancel(sid, payload),
        )

        try:
            await adapter.start()
            ready_event.set()
            logger.info("session_started", extra={"session_id": session_id, "runtime_type": runtime_type})
        except Exception:
            ready_event.set()
            self.adapters.pop(session_id, None)
            self.client.unregister_session_handlers(session_id)
            self.session_ready_events.pop(session_id, None)
            raise

    async def _enrich_skill_packages(self, session_id: str, data: dict[str, Any]) -> dict[str, Any]:
        raw_skills = data.get("skill_index")
        if not isinstance(raw_skills, list):
            return data

        enriched: list[dict[str, Any]] = []
        loaded_count = 0
        for item in raw_skills:
            if not isinstance(item, dict):
                continue
            copied = dict(item)
            skill_id = str(copied.get("id") or copied.get("name") or "").strip()
            if not skill_id:
                enriched.append(copied)
                continue
            try:
                result = await self.client.request(
                    session_id,
                    "get_skill_package",
                    skill_id=skill_id,
                )
                if isinstance(result, dict):
                    pkg = result.get("package")
                    if isinstance(pkg, dict):
                        copied["package"] = pkg
                        loaded_count += 1
            except Exception as exc:
                logger.warning(
                    "skill_package_load_failed",
                    extra={"session_id": session_id, "skill_id": skill_id, "error": str(exc)},
                )
            enriched.append(copied)

        logger.info(
            "skill_packages_enriched",
            extra={
                "session_id": session_id,
                "requested": len(raw_skills),
                "loaded": loaded_count,
            },
        )
        copied_data = dict(data)
        copied_data["skill_index"] = enriched
        return copied_data

    async def stop_session(self, data: dict[str, Any]) -> None:
        session_id = str(data.get("session_id", ""))
        adapter = self.adapters.pop(session_id, None)
        if not adapter:
            return

        self.session_ready_events.pop(session_id, None)
        self.client.unregister_session_handlers(session_id)
        await adapter.stop()
        logger.info("session_stopped", extra={"session_id": session_id})

    async def _on_user_message(self, session_id: str, payload: dict[str, Any]) -> None:
        ready_event = self.session_ready_events.get(session_id)
        if ready_event and not ready_event.is_set():
            try:
                await asyncio.wait_for(ready_event.wait(), timeout=15)
            except asyncio.TimeoutError:
                logger.warning("session_start_wait_timeout", extra={"session_id": session_id})
                await self.client.send_sse_event(
                    session_id,
                    {
                        "type": "execution_error",
                        "code": "SESSION_START_TIMEOUT",
                        "error": "session initialization timed out",
                    },
                )
                return

        adapter = self.adapters.get(session_id)
        if not adapter:
            return
        await adapter.handle_user_message(payload)
        await self._sync_snapshot_if_supported(session_id, adapter)

    async def _on_cancel(self, session_id: str, _payload: dict[str, Any]) -> None:
        adapter = self.adapters.get(session_id)
        if not adapter:
            return
        await adapter.cancel()
        await self._sync_snapshot_if_supported(session_id, adapter)

    async def _on_config_update(self, payload: dict[str, Any]) -> None:
        if not isinstance(payload, dict):
            return
        session_id = str(payload.get("session_id", ""))
        if not session_id:
            return
        adapter = self.adapters.get(session_id)
        if not adapter:
            return
        await adapter.update_config(payload)

    async def _sync_snapshot_if_supported(self, session_id: str, adapter: RuntimeAdapter) -> None:
        snapshot = await adapter.get_snapshot()
        if not snapshot:
            return
        checkpoint = snapshot.get("checkpoint")
        short_term = snapshot.get("short_term_memory")
        queue_state = snapshot.get("queue_state")
        if not isinstance(checkpoint, dict) and not isinstance(short_term, dict):
            return
        await self.client.fire_and_forget(
            session_id,
            "snapshot_sync",
            checkpoint=checkpoint if isinstance(checkpoint, dict) else {},
            short_term_memory=short_term if isinstance(short_term, dict) else {},
            conversation_state=snapshot.get("conversation_state") if isinstance(snapshot.get("conversation_state"), dict) else {},
            file_manifest=snapshot.get("file_manifest") if isinstance(snapshot.get("file_manifest"), dict) else {},
            queue_state=queue_state if isinstance(queue_state, dict) else {},
        )

    def get_active_sessions(self) -> list[str]:
        return list(self.adapters.keys())

    def _filter_skill_index_by_requirements(self, data: dict[str, Any]) -> dict[str, Any]:
        raw_skills = data.get("skill_index")
        if not isinstance(raw_skills, list):
            return data

        filtered: list[dict[str, Any]] = []
        for skill in raw_skills:
            if not isinstance(skill, dict):
                continue
            requires = skill.get("requires")
            if not isinstance(requires, dict):
                filtered.append(skill)
                continue

            binaries = requires.get("binaries")
            env_vars = requires.get("env_vars")

            missing_binaries = [
                b for b in binaries
                if isinstance(b, str) and b.strip() and shutil.which(b.strip()) is None
            ] if isinstance(binaries, list) else []
            missing_envs = [
                k for k in env_vars
                if isinstance(k, str) and k.strip() and not os.getenv(k.strip())
            ] if isinstance(env_vars, list) else []

            if missing_binaries or missing_envs:
                logger.warning(
                    "skill_requirements_unmet_skip",
                    extra={
                        "session_id": data.get("session_id"),
                        "skill_id": skill.get("id"),
                        "missing_binaries": missing_binaries,
                        "missing_env_vars": missing_envs,
                    },
                )
                continue

            filtered.append(skill)

        if len(filtered) == len(raw_skills):
            return data

        copied = dict(data)
        copied["skill_index"] = filtered
        return copied

    def _create_adapter(self, runtime_type: str, session_id: str, data: dict[str, Any]) -> RuntimeAdapter:
        if runtime_type not in SUPPORTED_RUNTIME_TYPES:
            raise ValueError(f"不支持的 runtime_type: {runtime_type}")

        if runtime_type == "openclaw":
            return OpenClawBridgeAdapter(self.client, session_id, data)

        return SemiGraphAdapter(
            client=self.client,
            session_id=session_id,
            org_id=self.org_id,
            user_id=self.user_id,
            init_data=self.init_data,
            start_payload=data,
        )
