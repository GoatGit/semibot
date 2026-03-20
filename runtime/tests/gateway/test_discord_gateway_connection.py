"""Tests for Discord gateway connection supervisor."""

from __future__ import annotations

from pathlib import Path

from src.gateway.discord_gateway_connection import DiscordGatewayConnectionSupervisor
from src.gateway.manager import GatewayManager
from src.server.config_store import RuntimeConfigStore


def test_discord_gateway_supervisor_desired_instances_filters(tmp_path: Path) -> None:
    db_path = tmp_path / "events.db"
    config_store = RuntimeConfigStore(db_path=str(db_path))
    manager = GatewayManager(
        config_store=config_store,
        gateway_context=None,  # type: ignore[arg-type]
        engine=None,  # type: ignore[arg-type]
    )
    manager.create_gateway_instance(
        {
            "provider": "discord",
            "instanceKey": "discord-main",
            "displayName": "Discord",
            "isDefault": True,
            "isActive": True,
            "mode": "gateway",
            "config": {"botToken": "discord_token"},
        }
    )
    manager.create_gateway_instance(
        {
            "provider": "discord",
            "instanceKey": "discord-bad",
            "displayName": "Discord Bad",
            "isDefault": False,
            "isActive": True,
            "mode": "webhook",
            "config": {"botToken": "discord_token_2"},
        }
    )

    supervisor = DiscordGatewayConnectionSupervisor(
        gateway_manager=manager,
        runtime_base_url="http://127.0.0.1:8765",
        internal_token="internal_token",
    )
    desired = supervisor._desired_instances()  # noqa: SLF001
    assert list(desired.keys()) == [manager.list_provider_instances("discord", active_only=True)[0]["id"]]
    spec = next(iter(desired.values()))
    assert spec["bot_token"] == "discord_token"

