from __future__ import annotations

import json
from pathlib import Path

import httpx
import pytest

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
async def test_whatsapp_and_imessage_internal_routes_use_plugin_contract(tmp_path: Path) -> None:
    db_path = tmp_path / "events.db"
    rules_path = tmp_path / "rules.json"
    _write_rules(rules_path)

    async def _task_runner(**kwargs):
        return {
            "status": "success",
            "task": kwargs.get("task"),
            "session_id": kwargs.get("session_id"),
            "agent_id": kwargs.get("agent_id"),
            "final_response": "done",
            "runtime_events": [],
            "error": None,
        }

    async def _imessage_send(_bridge_url, _payload, _timeout):
        return None

    app = create_app(
        db_path=str(db_path),
        rules_path=str(rules_path),
        task_runner=_task_runner,
        imessage_send_fn=_imessage_send,
    )
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        wa_create = await client.post(
            "/v1/config/gateway-instances",
            json={
                "provider": "whatsapp",
                "instanceKey": "wa-main",
                "displayName": "WhatsApp",
                "isDefault": True,
                "isActive": True,
                "mode": "gateway",
                "config": {"sessionName": "phone-a"},
            },
        )
        assert wa_create.status_code == 201
        wa_instance_id = wa_create.json()["id"]

        wa_test = await client.post(
            f"/v1/config/gateway-instances/{wa_instance_id}/test",
            json={"text": "hello"},
        )
        assert wa_test.status_code == 501
        assert wa_test.json()["detail"] == "whatsapp_not_configured"

        wa_internal = await client.post(
            f"/v1/integrations/whatsapp/events/internal?instance_id={wa_instance_id}",
            headers={"x-semibot-internal-token": app.state.whatsapp_internal_token},
            json={
                "type": "message_upsert",
                "data": {
                    "id": "wa-msg-1",
                    "chat_id": "8613800000000@s.whatsapp.net",
                    "sender_id": "8613900000000@s.whatsapp.net",
                    "chat_type": "dm",
                    "text": "hello from whatsapp",
                },
            },
        )
        assert wa_internal.status_code == 200
        assert wa_internal.json()["accepted"] is True

        attachment_path = tmp_path / "sample.txt"
        attachment_path.write_text("hello", encoding="utf-8")
        wa_internal_attachment = await client.post(
            f"/v1/integrations/whatsapp/events/internal?instance_id={wa_instance_id}",
            headers={"x-semibot-internal-token": app.state.whatsapp_internal_token},
            json={
                "type": "message_upsert",
                "data": {
                    "id": "wa-msg-2",
                    "chat_id": "8613800000000@s.whatsapp.net",
                    "sender_id": "8613900000000@s.whatsapp.net",
                    "chat_type": "dm",
                    "attachments": [{"local_path": str(attachment_path), "file_name": "sample.txt"}],
                },
            },
        )
        assert wa_internal_attachment.status_code == 200
        assert wa_internal_attachment.json()["accepted"] is True

        im_create = await client.post(
            "/v1/config/gateway-instances",
            json={
                "provider": "imessage",
                "instanceKey": "im-main",
                "displayName": "iMessage",
                "isDefault": True,
                "isActive": True,
                "mode": "gateway",
                "config": {"bridgeUrl": "http://127.0.0.1:12345", "defaultHandle": "+8613800000000"},
            },
        )
        assert im_create.status_code == 201
        im_instance_id = im_create.json()["id"]

        im_test = await client.post(
            f"/v1/config/gateway-instances/{im_instance_id}/test",
            json={"text": "hello"},
        )
        assert im_test.status_code == 200
        assert im_test.json()["sent"] is True

        im_internal = await client.post(
            f"/v1/integrations/imessage/events/internal?instance_id={im_instance_id}",
            headers={"x-semibot-internal-token": app.state.imessage_internal_token},
            json={
                "type": "message",
                "data": {
                    "id": "im-msg-1",
                    "handle": "+8613800000000",
                    "sender_id": "+8613900000000",
                    "chat_type": "dm",
                    "text": "hello from imessage",
                },
            },
        )
        assert im_internal.status_code == 200
        assert im_internal.json()["accepted"] is True
