from __future__ import annotations

import asyncio
import os
import signal
from contextlib import suppress

from src.session.manager import SessionManager
from src.utils.logging import get_logger
from src.ws.client import ControlPlaneClient

logger = get_logger(__name__)

DEFAULT_CONTROL_PLANE_WS = "ws://127.0.0.1:3001/ws/vm"


def _required_env(name: str) -> str:
    value = os.getenv(name, "").strip()
    if not value:
        raise RuntimeError(f"{name} is required for execution-plane mode")
    return value


async def run_execution_plane() -> None:
    user_id = _required_env("VM_USER_ID")
    token = _required_env("VM_TOKEN")
    ticket = os.getenv("VM_TICKET", "").strip()
    control_plane_ws = os.getenv("CONTROL_PLANE_WS", DEFAULT_CONTROL_PLANE_WS).strip() or DEFAULT_CONTROL_PLANE_WS

    client = ControlPlaneClient(
        control_plane_url=control_plane_ws,
        user_id=user_id,
        ticket=ticket,
        token=token,
    )

    manager: SessionManager | None = None
    stop_event = asyncio.Event()

    try:
        init_data = await client.connect()
        manager = SessionManager(client=client, init_data=init_data)
        client.register_vm_handlers(
            start_session=manager.start_session,
            stop_session=manager.stop_session,
            config_update=manager._on_config_update,
        )

        loop = asyncio.get_running_loop()
        for sig in (signal.SIGINT, signal.SIGTERM):
            with suppress(NotImplementedError):
                loop.add_signal_handler(sig, stop_event.set)

        logger.info(
            "execution_plane_started",
            extra={
                "user_id": user_id,
                "control_plane_ws": control_plane_ws,
            },
        )
        await stop_event.wait()
    finally:
        if manager is not None:
            for session_id, adapter in list(manager.adapters.items()):
                with suppress(Exception):
                    await adapter.stop()
                client.unregister_session_handlers(session_id)
        with suppress(Exception):
            await client.close()

