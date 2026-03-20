"""Tests for Discord gateway config and internal ingestion endpoints."""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any

import httpx
import pytest

from src.gateway.channels.discord import ingress as discord_ingress
from src.server.api import create_app


def _write_rules(path: Path) -> None:
    path.write_text(
        json.dumps(
            [
                {
                    "id": "rule_chat_message",
                    "name": "rule_chat_message",
                    "event_type": "chat.message.received",
                    "action_mode": "suggest",
                    "actions": [{"action_type": "notify"}],
                    "is_active": True,
                }
            ],
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )


@pytest.mark.asyncio
async def test_discord_gateway_instance_test_and_internal_ingest(tmp_path: Path):
    db_path = tmp_path / "events.db"
    rules_path = tmp_path / "rules.json"
    _write_rules(rules_path)
    sent: list[dict[str, Any]] = []

    async def _discord_send(token: str, channel_id: str, payload: dict[str, Any], files, timeout: float) -> None:
        sent.append(
            {
                "token": token,
                "channel_id": channel_id,
                "payload": payload,
                "files": files,
                "timeout": timeout,
            }
        )

    async def _task_runner(**kwargs):
        task = str(kwargs.get("task") or "")
        return {
            "status": "success",
            "task": task,
            "session_id": kwargs.get("session_id"),
            "agent_id": kwargs.get("agent_id"),
            "final_response": f"done: {task}",
            "runtime_events": [],
            "error": None,
        }

    app = create_app(
        db_path=str(db_path),
        rules_path=str(rules_path),
        discord_send_fn=_discord_send,
        task_runner=_task_runner,
    )
    internal_token = app.state.discord_gateway_internal_token
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        created = await client.post(
            "/v1/config/gateway-instances",
            json={
                "provider": "discord",
                "instanceKey": "discord-main",
                "displayName": "Discord",
                "isDefault": True,
                "isActive": True,
                "mode": "gateway",
                "config": {
                    "botToken": "discord_token",
                    "botUserId": "bot_001",
                    "defaultChannelId": "chan_001",
                    "addressingPolicy": {"mode": "all_messages", "executeOnUnaddressed": True},
                },
            },
        )
        assert created.status_code == 201
        instance_id = created.json()["id"]

        test_resp = await client.post(
            f"/v1/config/gateway-instances/{instance_id}/test",
            json={"text": "hello discord", "channelId": "chan_002"},
        )
        assert test_resp.status_code == 200
        assert test_resp.json()["sent"] is True
        assert sent[-1]["channel_id"] == "chan_002"

        ingest = await client.post(
            f"/v1/integrations/discord/events/internal?instance_id={instance_id}",
            headers={"x-semibot-internal-token": internal_token},
            json={
                "type": "message_create",
                "bot_user_id": "bot_001",
                "data": {
                    "id": "msg_001",
                    "channel_id": "chan_001",
                    "guild_id": "guild_001",
                    "content": "hello discord",
                    "author": {"id": "user_001", "username": "alice", "bot": False},
                    "mentions": [{"id": "bot_001", "username": "semibot", "bot": True}],
                    "attachments": [],
                },
            },
        )
        assert ingest.status_code == 200
        payload = ingest.json()
        assert payload["accepted"] is True
        assert payload["event_type"] == "chat.message.received"
        assert payload["should_execute"] is True
        assert payload["agent_id"] == "semibot"


@pytest.mark.asyncio
async def test_discord_gateway_attachment_download_uses_channel_local_ingress(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    db_path = tmp_path / "events.db"
    rules_path = tmp_path / "rules.json"
    _write_rules(rules_path)
    sent: list[dict[str, Any]] = []
    runner_calls: list[dict[str, Any]] = []

    async def _discord_send(token: str, channel_id: str, payload: dict[str, Any], files, timeout: float) -> None:
        sent.append(
            {
                "token": token,
                "channel_id": channel_id,
                "payload": payload,
                "files": files,
                "timeout": timeout,
            }
        )

    async def _task_runner(**kwargs):
        runner_calls.append(dict(kwargs))
        task = str(kwargs.get("task") or "")
        return {
            "status": "success",
            "task": task,
            "session_id": kwargs.get("session_id"),
            "agent_id": kwargs.get("agent_id"),
            "final_response": f"done: {task}",
            "runtime_events": [],
            "error": None,
        }

    async def _fake_download(
        manager,
        *,
        channel_id: str,
        message_id: Any,
        attachments: list[dict[str, Any]],
    ) -> list[dict[str, Any]]:
        assert channel_id == "chan_001"
        assert message_id == "msg_attach_001"
        assert len(attachments) == 1
        return [
            {
                **attachments[0],
                "status": "downloaded",
                "local_path": str((tmp_path / "inbound" / "discord" / "report.csv").resolve()),
                "stored_size": 567,
            }
        ]

    monkeypatch.setattr(discord_ingress, "download_attachments", _fake_download)

    app = create_app(
        db_path=str(db_path),
        rules_path=str(rules_path),
        discord_send_fn=_discord_send,
        task_runner=_task_runner,
    )
    internal_token = app.state.discord_gateway_internal_token
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        created = await client.post(
            "/v1/config/gateway-instances",
            json={
                "provider": "discord",
                "instanceKey": "discord-attach",
                "displayName": "Discord Attach",
                "isDefault": True,
                "isActive": True,
                "mode": "gateway",
                "config": {
                    "botToken": "discord_token",
                    "botUserId": "bot_001",
                    "defaultChannelId": "chan_001",
                    "addressingPolicy": {"mode": "all_messages", "executeOnUnaddressed": True},
                },
            },
        )
        assert created.status_code == 201
        instance_id = created.json()["id"]

        ingest = await client.post(
            f"/v1/integrations/discord/events/internal?instance_id={instance_id}",
            headers={"x-semibot-internal-token": internal_token},
            json={
                "type": "message_create",
                "bot_user_id": "bot_001",
                "data": {
                    "id": "msg_attach_001",
                    "channel_id": "chan_001",
                    "guild_id": "guild_001",
                    "content": "",
                    "author": {"id": "user_001", "username": "alice", "bot": False},
                    "mentions": [{"id": "bot_001", "username": "semibot", "bot": True}],
                    "attachments": [
                        {
                            "id": "att_001",
                            "filename": "report.csv",
                            "url": "https://cdn.discordapp.test/report.csv",
                            "content_type": "text/csv",
                            "size": 567,
                        }
                    ],
                },
            },
        )
        assert ingest.status_code == 200
        payload = ingest.json()
        assert payload["accepted"] is True
        assert payload["should_execute"] is True

        for _ in range(20):
            if runner_calls:
                break
            await asyncio.sleep(0.05)

        assert runner_calls
        task = str(runner_calls[-1].get("task") or "")
        assert "report.csv" in task
        assert "local_path" not in task
        assert "path=" in task
        assert "用户上传了 1 个文件" in task
        assert sent
        assert "done:" in str(sent[-1]["payload"]["content"])
