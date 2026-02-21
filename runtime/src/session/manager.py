from __future__ import annotations

from typing import Any

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
        self.init_data = init_data
        self.user_id = str(init_data.get("user_id", ""))
        self.org_id = str(init_data.get("org_id", ""))
        self.adapters: dict[str, RuntimeAdapter] = {}

        self.client.set_active_sessions_provider(self.get_active_sessions)

    async def start_session(self, data: dict[str, Any]) -> None:
        session_id = str(data.get("session_id", ""))
        if not session_id:
            return

        if session_id in self.adapters:
            return

        runtime_type = str(data.get("runtime_type", "semigraph"))
        adapter = self._create_adapter(runtime_type, session_id, data)
        self.adapters[session_id] = adapter

        self.client.register_session_handlers(
            session_id,
            user_message=lambda payload, sid=session_id: self._on_user_message(sid, payload),
            cancel=lambda payload, sid=session_id: self._on_cancel(sid, payload),
        )

        await adapter.start()
        logger.info("session_started", extra={"session_id": session_id, "runtime_type": runtime_type})

    async def stop_session(self, data: dict[str, Any]) -> None:
        session_id = str(data.get("session_id", ""))
        adapter = self.adapters.pop(session_id, None)
        if not adapter:
            return

        self.client.unregister_session_handlers(session_id)
        await adapter.stop()
        logger.info("session_stopped", extra={"session_id": session_id})

    async def _on_user_message(self, session_id: str, payload: dict[str, Any]) -> None:
        adapter = self.adapters.get(session_id)
        if not adapter:
            return
        await adapter.handle_user_message(payload)

    async def _on_cancel(self, session_id: str, _payload: dict[str, Any]) -> None:
        adapter = self.adapters.get(session_id)
        if not adapter:
            return
        await adapter.cancel()

    def get_active_sessions(self) -> list[str]:
        return list(self.adapters.keys())

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
