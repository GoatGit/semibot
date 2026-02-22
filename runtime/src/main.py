from __future__ import annotations

import asyncio
import os

from src.session.manager import SessionManager
from src.utils.logging import get_logger
from src.ws.client import ControlPlaneClient

logger = get_logger(__name__)


async def _run() -> None:
    control_plane_ws = os.getenv("CONTROL_PLANE_WS", "ws://localhost:3001/ws/vm")
    user_id = os.getenv("VM_USER_ID", "")
    ticket = os.getenv("VM_TICKET", "")
    token = os.getenv("VM_TOKEN", "")

    if not user_id or not token:
        raise RuntimeError("VM_USER_ID 和 VM_TOKEN 必须配置")

    client = ControlPlaneClient(
        control_plane_url=control_plane_ws,
        user_id=user_id,
        ticket=ticket,
        token=token,
    )

    init_data = await client.connect()
    manager = SessionManager(client=client, init_data=init_data)

    client.register_vm_handlers(
        start_session=manager.start_session,
        stop_session=manager.stop_session,
        config_update=manager._on_config_update,
    )

    logger.info("execution_plane_started", extra={"user_id": user_id})

    while True:
        await asyncio.sleep(3600)


def main() -> None:
    asyncio.run(_run())


if __name__ == "__main__":
    main()
