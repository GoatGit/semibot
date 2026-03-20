"""Unit-ish tests for GatewayManager service layer."""

from __future__ import annotations

import asyncio
import json
import os
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from uuid import uuid4

import pytest

from src.events.event_engine import EventEngine
from src.events.event_router import EventRouter, NoopActionExecutor
from src.events.event_store import EventStore
from src.events.models import ApprovalRequest, Event
from src.gateway.context_service import GatewayContextService
from src.gateway.channels.imessage.connection import IMessageConnectionSupervisor
from src.gateway.channels.whatsapp.connection import WhatsAppConnectionSupervisor
from src.gateway.manager import GatewayManager, GatewayManagerError
from src.server.config_store import RuntimeConfigStore


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
                },
                {
                    "id": "rule_high",
                    "name": "rule_high",
                    "event_type": "fund.transfer",
                    "action_mode": "auto",
                    "risk_level": "high",
                    "actions": [{"action_type": "notify"}],
                    "is_active": True,
                },
            ],
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )


def _build_manager(
    *,
    db_path: Path,
    rules_path: Path,
    feishu_send_fn=None,
    feishu_sdk_send_fn=None,
    telegram_send_fn=None,
    telegram_send_document_fn=None,
    discord_send_fn=None,
    imessage_send_fn=None,
) -> GatewayManager:
    config_store = RuntimeConfigStore(db_path=str(db_path))
    engine = EventEngine(
        store=EventStore(db_path=str(db_path)),
        router=EventRouter(NoopActionExecutor()),
        rules_path=str(rules_path),
    )

    async def _task_runner(**kwargs: Any) -> dict[str, Any]:
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

    gateway_context = GatewayContextService(
        db_path=str(db_path),
        config_store=config_store,
        task_runner=_task_runner,
        runtime_db_path=str(db_path),
        rules_path=str(rules_path),
    )
    return GatewayManager(
        config_store=config_store,
        gateway_context=gateway_context,
        engine=engine,
        feishu_send_fn=feishu_send_fn,
        feishu_sdk_send_fn=feishu_sdk_send_fn,
        telegram_send_fn=telegram_send_fn,
        telegram_send_document_fn=telegram_send_document_fn,
        discord_send_fn=discord_send_fn,
        imessage_send_fn=imessage_send_fn,
    )


@pytest.mark.asyncio
async def test_gateway_manager_config_and_test_send(tmp_path: Path):
    db_path = tmp_path / "events.db"
    rules_path = tmp_path / "rules.json"
    _write_rules(rules_path)

    sent: list[dict[str, Any]] = []

    async def _send(token: str, payload: dict[str, Any], timeout: float) -> None:
        sent.append({"token": token, "payload": payload, "timeout": timeout})

    manager = _build_manager(db_path=db_path, rules_path=rules_path, telegram_send_fn=_send)
    assert manager.channel_plugins.providers() == ["discord", "feishu", "imessage", "telegram", "whatsapp"]
    listing = manager.list_gateway_configs()
    providers = {item["provider"] for item in listing}
    assert providers == {"feishu", "telegram"}

    updated = manager.upsert_gateway_config(
        "telegram",
        {
            "isActive": True,
            "config": {
                "botToken": "123456:abc",
            },
        },
    )
    assert updated["status"] == "ready"
    assert updated["config"]["botToken"] == "***"

    result = await manager.test_gateway("telegram", {"text": "gateway test", "chat_id": "-100001"})
    assert result["sent"] is True
    assert len(sent) == 1
    assert sent[0]["payload"]["chat_id"] == "-100001"
    assert sent[0]["payload"]["text"] == "gateway test"

    with pytest.raises(GatewayManagerError) as exc:
        manager.get_gateway_config("unknown")
    assert exc.value.detail == "unsupported_gateway_provider"


@pytest.mark.asyncio
async def test_gateway_manager_registers_placeholder_whatsapp_and_imessage_plugins(tmp_path: Path):
    os.environ["SEMIBOT_WHATSAPP_STATE_DIR"] = str(tmp_path / "whatsapp-state")
    db_path = tmp_path / "events.db"
    rules_path = tmp_path / "rules.json"
    _write_rules(rules_path)

    manager = _build_manager(db_path=db_path, rules_path=rules_path)

    whatsapp = manager.create_gateway_instance(
        {
            "provider": "whatsapp",
            "instanceKey": "whatsapp-main",
            "displayName": "WhatsApp",
            "isDefault": True,
            "isActive": True,
            "mode": "gateway",
            "config": {},
        }
    )
    imessage = manager.create_gateway_instance(
        {
            "provider": "imessage",
            "instanceKey": "imessage-main",
            "displayName": "iMessage",
            "isDefault": True,
            "isActive": True,
            "mode": "gateway",
            "config": {},
        }
    )

    assert whatsapp["status"] == "not_configured"
    assert imessage["status"] == "not_configured"

    with pytest.raises(GatewayManagerError) as whatsapp_exc:
        await manager.test_gateway("whatsapp", {"text": "hello"})
    assert whatsapp_exc.value.detail == "whatsapp_not_configured"
    assert whatsapp_exc.value.status_code == 501

    with pytest.raises(GatewayManagerError) as imessage_exc:
        await manager.test_gateway("imessage", {"text": "hello"})
    assert imessage_exc.value.detail == "imessage_not_configured"
    assert imessage_exc.value.status_code == 501

    whatsapp_plugin = manager.channel_plugin("whatsapp")
    imessage_plugin = manager.channel_plugin("imessage")
    assert whatsapp_plugin is not None
    assert imessage_plugin is not None
    whatsapp_supervisor = whatsapp_plugin.build_connection_supervisor(
        manager,
        runtime_base_url="http://127.0.0.1:8765",
        internal_token="wa_internal",
    )
    imessage_supervisor = imessage_plugin.build_connection_supervisor(
        manager,
        runtime_base_url="http://127.0.0.1:8765",
        internal_token="im_internal",
    )
    assert isinstance(whatsapp_supervisor, WhatsAppConnectionSupervisor)
    assert isinstance(imessage_supervisor, IMessageConnectionSupervisor)
    assert whatsapp_supervisor._desired_instances() == {}  # noqa: SLF001
    assert imessage_supervisor._desired_instances() == []  # noqa: SLF001


@pytest.mark.asyncio
async def test_whatsapp_gateway_queues_outbound_message(tmp_path: Path):
    os.environ["SEMIBOT_WHATSAPP_STATE_DIR"] = str(tmp_path / "whatsapp-state")
    db_path = tmp_path / "events.db"
    rules_path = tmp_path / "rules.json"
    _write_rules(rules_path)

    manager = _build_manager(db_path=db_path, rules_path=rules_path)
    whatsapp = manager.create_gateway_instance(
        {
            "provider": "whatsapp",
            "instanceKey": "whatsapp-main",
            "displayName": "WhatsApp",
            "isDefault": True,
            "isActive": True,
            "mode": "gateway",
            "config": {
                "sessionName": "phone-a",
            },
        }
    )

    result = await manager.test_gateway(
        "whatsapp",
        {"instance_id": whatsapp["id"], "text": "hello", "chat_id": "8613800000000@s.whatsapp.net"},
    )
    assert result == {"sent": True, "queued": True}

    supervisor = manager.channel_plugin("whatsapp").build_connection_supervisor(  # type: ignore[union-attr]
        manager,
        runtime_base_url="http://127.0.0.1:8765",
        internal_token="wa_internal",
    )
    desired = supervisor._desired_instances()  # noqa: SLF001
    assert list(desired.keys()) == [whatsapp["id"]]
    spec = desired[whatsapp["id"]]
    assert spec["session_name"] == "phone-a"


@pytest.mark.asyncio
async def test_whatsapp_gateway_queues_outbound_file(tmp_path: Path):
    os.environ["SEMIBOT_WHATSAPP_STATE_DIR"] = str(tmp_path / "whatsapp-state")
    db_path = tmp_path / "events.db"
    rules_path = tmp_path / "rules.json"
    _write_rules(rules_path)

    attachment = tmp_path / "report.txt"
    attachment.write_text("hello", encoding="utf-8")

    manager = _build_manager(db_path=db_path, rules_path=rules_path)
    whatsapp = manager.create_gateway_instance(
        {
            "provider": "whatsapp",
            "instanceKey": "whatsapp-main",
            "displayName": "WhatsApp",
            "isDefault": True,
            "isActive": True,
            "mode": "gateway",
            "config": {
                "sessionName": "phone-a",
            },
        }
    )

    notifier = manager.build_whatsapp_notifier(whatsapp)
    assert notifier is not None
    sent = await notifier.send_notify_payload(
        {
            "text": "report ready",
            "chat_id": "8613800000000@s.whatsapp.net",
            "files": [{"local_path": str(attachment), "filename": "report.txt", "mime_type": "text/plain"}],
        }
    )
    assert sent is True
    outbox = tmp_path / "whatsapp-state" / whatsapp["id"] / "outbox"
    queued = list(outbox.glob("*.json"))
    assert len(queued) == 1
    payload = json.loads(queued[0].read_text(encoding="utf-8"))
    assert payload["chat_id"] == "8613800000000@s.whatsapp.net"
    assert payload["files"] == [
        {"local_path": str(attachment), "filename": "report.txt", "mime_type": "text/plain"}
    ]


@pytest.mark.asyncio
async def test_imessage_gateway_sends_via_bridge_contract(tmp_path: Path):
    db_path = tmp_path / "events.db"
    rules_path = tmp_path / "rules.json"
    _write_rules(rules_path)

    sent: list[dict[str, Any]] = []

    async def _send(bridge_url: str, payload: dict[str, Any], timeout: float) -> None:
        sent.append({"bridge_url": bridge_url, "payload": payload, "timeout": timeout})

    manager = _build_manager(
        db_path=db_path,
        rules_path=rules_path,
        imessage_send_fn=_send,
    )
    instance = manager.create_gateway_instance(
        {
            "provider": "imessage",
            "instanceKey": "imessage-main",
            "displayName": "iMessage",
            "isDefault": True,
            "isActive": True,
            "mode": "bridge",
            "config": {
                "bridgeUrl": "http://127.0.0.1:31337",
                "defaultHandle": "+8613800000000",
            },
        }
    )

    result = await manager.test_gateway("imessage", {"instance_id": instance["id"], "text": "hello"})
    assert result == {"sent": True}
    assert sent == [
        {
            "bridge_url": "http://127.0.0.1:31337",
            "payload": {"handle": "+8613800000000", "text": "hello", "files": []},
            "timeout": 10.0,
        }
    ]


@pytest.mark.asyncio
async def test_gateway_context_uses_agent_llm_config(tmp_path: Path):
    db_path = tmp_path / "events.db"
    rules_path = tmp_path / "rules.json"
    _write_rules(rules_path)

    captured: dict[str, Any] = {}

    async def _task_runner(**kwargs: Any) -> dict[str, Any]:
        captured.update(kwargs)
        return {
            "status": "success",
            "task": kwargs.get("task"),
            "session_id": kwargs.get("session_id"),
            "agent_id": kwargs.get("agent_id"),
            "final_response": "done",
            "runtime_events": [],
            "error": None,
        }

    config_store = RuntimeConfigStore(db_path=str(db_path))
    config_store.create_agent_profile(
        {
            "id": "agent_kimi",
            "name": "Kimi Agent",
            "system_prompt": "You are Kimi agent.",
            "model": "kimi-k2.5",
            "metadata": {
                "config": {
                    "modelProviderKey": "kimi:kimiprovider",
                    "fallbackModel": "kimi-k2-thinking",
                    "fallbackProviderKey": "kimi:kimiprovider",
                }
            },
        }
    )

    gateway_context = GatewayContextService(
        db_path=str(db_path),
        config_store=config_store,
        task_runner=_task_runner,
        runtime_db_path=str(db_path),
        rules_path=str(rules_path),
    )

    delivered: list[tuple[str, dict[str, Any]]] = []

    async def _on_result(text: str, ctx: dict[str, Any]) -> bool:
        delivered.append((text, ctx))
        return True

    result = await gateway_context.ingest_message(
        provider="feishu",
        event_payload={
            "bot_id": "bot_1",
            "chat_id": "chat_1",
            "chat_type": "p2p",
            "sender_id": "user_1",
        },
        source="feishu.channel",
        subject="chat_1",
        text="你好",
        agent_id="agent_kimi",
        on_result=_on_result,
    )

    assert result["agent_id"] == "agent_kimi"
    await asyncio.sleep(0.05)
    assert captured["agent_id"] == "agent_kimi"
    assert captured["model"] == "kimi-k2.5"
    assert captured["model_provider_key"] == "kimi:kimiprovider"
    assert captured["fallback_model"] == "kimi-k2-thinking"
    assert captured["fallback_provider_key"] == "kimi:kimiprovider"
    assert captured["system_prompt"] == "You are Kimi agent."
    assert delivered


@pytest.mark.asyncio
async def test_gateway_context_non_executable_message_does_not_create_runtime_session(tmp_path: Path):
    db_path = tmp_path / "events.db"
    rules_path = tmp_path / "rules.json"
    _write_rules(rules_path)

    async def _task_runner(**kwargs: Any) -> dict[str, Any]:
        raise AssertionError(f"task runner should not be called: {kwargs}")

    gateway_context = GatewayContextService(
        db_path=str(db_path),
        config_store=RuntimeConfigStore(db_path=str(db_path)),
        task_runner=_task_runner,
        runtime_db_path=str(db_path),
        rules_path=str(rules_path),
    )

    result = await gateway_context.ingest_message(
        provider="feishu",
        event_payload={
            "instance_id": "feishu-main",
            "app_id": "cli_xxx",
            "chat_id": "oc_group_1",
            "chat_type": "group",
            "sender_id": "ou_xxx",
            "is_mention": False,
        },
        source="feishu.channel",
        subject="oc_group_1",
        text="旁路消息",
    )

    assert result["should_execute"] is False
    assert result["runtime_session_id"] is None
    assert result["task_run_id"] is None

    conversation = gateway_context.list_conversations(provider="feishu")[0]
    assert conversation["active_runtime_session_id"] is None
    assert conversation["active_runtime_session_status"] == "idle"
    assert gateway_context.list_task_runs(conversation["id"]) == []


@pytest.mark.asyncio
async def test_gateway_context_reuses_mounted_runtime_session_for_next_executable_message(tmp_path: Path):
    db_path = tmp_path / "events.db"
    rules_path = tmp_path / "rules.json"
    _write_rules(rules_path)

    async def _task_runner(**kwargs: Any) -> dict[str, Any]:
        return {
            "status": "success",
            "task": kwargs.get("task"),
            "session_id": kwargs.get("session_id"),
            "agent_id": kwargs.get("agent_id"),
            "final_response": "done",
            "runtime_events": [],
            "error": None,
        }

    gateway_context = GatewayContextService(
        db_path=str(db_path),
        config_store=RuntimeConfigStore(db_path=str(db_path)),
        task_runner=_task_runner,
        runtime_db_path=str(db_path),
        rules_path=str(rules_path),
    )

    first = await gateway_context.ingest_message(
        provider="telegram",
        event_payload={
            "instance_id": "tg-main",
            "bot_id": "bot_1",
            "chat_id": "chat_1",
            "chat_type": "private",
            "sender_id": "user_1",
        },
        source="telegram.channel",
        subject="chat_1",
        text="你好",
        force_execute=True,
    )
    await asyncio.sleep(0.05)

    conversation = gateway_context.list_conversations(provider="telegram")[0]
    assert conversation["active_runtime_session_id"] == first["runtime_session_id"]
    assert conversation["active_runtime_session_status"] == "idle"

    second = await gateway_context.ingest_message(
        provider="telegram",
        event_payload={
            "instance_id": "tg-main",
            "bot_id": "bot_1",
            "chat_id": "chat_1",
            "chat_type": "private",
            "sender_id": "user_1",
        },
        source="telegram.channel",
        subject="chat_1",
        text="继续",
        force_execute=True,
    )
    await asyncio.sleep(0.05)

    assert second["runtime_session_id"] == first["runtime_session_id"]


@pytest.mark.asyncio
async def test_gateway_context_forks_mounted_runtime_session_when_busy(tmp_path: Path):
    db_path = tmp_path / "events.db"
    rules_path = tmp_path / "rules.json"
    _write_rules(rules_path)
    release = asyncio.Event()

    async def _task_runner(**kwargs: Any) -> dict[str, Any]:
        if "第一个任务" in str(kwargs.get("task") or ""):
            await release.wait()
        return {
            "status": "success",
            "task": kwargs.get("task"),
            "session_id": kwargs.get("session_id"),
            "agent_id": kwargs.get("agent_id"),
            "final_response": "done",
            "runtime_events": [],
            "error": None,
        }

    gateway_context = GatewayContextService(
        db_path=str(db_path),
        config_store=RuntimeConfigStore(db_path=str(db_path)),
        task_runner=_task_runner,
        runtime_db_path=str(db_path),
        rules_path=str(rules_path),
    )

    first = await gateway_context.ingest_message(
        provider="telegram",
        event_payload={
            "instance_id": "tg-main",
            "bot_id": "bot_1",
            "chat_id": "chat_1",
            "chat_type": "private",
            "sender_id": "user_1",
        },
        source="telegram.channel",
        subject="chat_1",
        text="第一个任务",
        force_execute=True,
    )
    await asyncio.sleep(0.02)

    second = await gateway_context.ingest_message(
        provider="telegram",
        event_payload={
            "instance_id": "tg-main",
            "bot_id": "bot_1",
            "chat_id": "chat_1",
            "chat_type": "private",
            "sender_id": "user_1",
        },
        source="telegram.channel",
        subject="chat_1",
        text="第二个任务",
        force_execute=True,
    )

    assert second["runtime_session_id"] != first["runtime_session_id"]
    assert second["forked_from_session_id"] == first["runtime_session_id"]

    conversation = gateway_context.list_conversations(provider="telegram")[0]
    assert conversation["active_runtime_session_id"] == second["runtime_session_id"]

    release.set()
    await asyncio.sleep(0.05)


@pytest.mark.asyncio
async def test_gateway_context_forks_mounted_runtime_session_when_awaiting_approval(tmp_path: Path):
    db_path = tmp_path / "events.db"
    rules_path = tmp_path / "rules.json"
    _write_rules(rules_path)

    async def _task_runner(**kwargs: Any) -> dict[str, Any]:
        return {
            "status": "success",
            "task": kwargs.get("task"),
            "session_id": kwargs.get("session_id"),
            "agent_id": kwargs.get("agent_id"),
            "final_response": "done",
            "runtime_events": [],
            "error": None,
        }

    gateway_context = GatewayContextService(
        db_path=str(db_path),
        config_store=RuntimeConfigStore(db_path=str(db_path)),
        task_runner=_task_runner,
        runtime_db_path=str(db_path),
        rules_path=str(rules_path),
    )

    first = await gateway_context.ingest_message(
        provider="telegram",
        event_payload={
            "instance_id": "tg-main",
            "bot_id": "bot_1",
            "chat_id": "chat_1",
            "chat_type": "private",
            "sender_id": "user_1",
        },
        source="telegram.channel",
        subject="chat_1",
        text="需要审批的任务",
        force_execute=True,
    )
    await asyncio.sleep(0.05)

    conversation = gateway_context.list_conversations(provider="telegram")[0]
    gateway_context.store.set_active_runtime_session(
        conversation["id"],
        runtime_session_id=first["runtime_session_id"],
        status="awaiting_approval",
    )
    conversation = gateway_context.list_conversations(provider="telegram")[0]
    assert conversation["active_runtime_session_id"] == first["runtime_session_id"]
    assert conversation["active_runtime_session_status"] == "awaiting_approval"

    second = await gateway_context.ingest_message(
        provider="telegram",
        event_payload={
            "instance_id": "tg-main",
            "bot_id": "bot_1",
            "chat_id": "chat_1",
            "chat_type": "private",
            "sender_id": "user_1",
        },
        source="telegram.channel",
        subject="chat_1",
        text="审批期间的新任务",
        force_execute=True,
    )

    assert second["runtime_session_id"] != first["runtime_session_id"]
    assert second["forked_from_session_id"] == first["runtime_session_id"]

    conversation = gateway_context.list_conversations(provider="telegram")[0]
    assert conversation["active_runtime_session_id"] == second["runtime_session_id"]


@pytest.mark.asyncio
async def test_gateway_context_replaces_failed_mounted_runtime_session(tmp_path: Path):
    db_path = tmp_path / "events.db"
    rules_path = tmp_path / "rules.json"
    _write_rules(rules_path)

    async def _task_runner(**kwargs: Any) -> dict[str, Any]:
        task = str(kwargs.get("task") or "")
        if "失败任务" in task:
            raise RuntimeError("boom")
        return {
            "status": "success",
            "task": kwargs.get("task"),
            "session_id": kwargs.get("session_id"),
            "agent_id": kwargs.get("agent_id"),
            "final_response": "done",
            "runtime_events": [],
            "error": None,
        }

    gateway_context = GatewayContextService(
        db_path=str(db_path),
        config_store=RuntimeConfigStore(db_path=str(db_path)),
        task_runner=_task_runner,
        runtime_db_path=str(db_path),
        rules_path=str(rules_path),
    )

    first = await gateway_context.ingest_message(
        provider="telegram",
        event_payload={
            "instance_id": "tg-main",
            "bot_id": "bot_1",
            "chat_id": "chat_1",
            "chat_type": "private",
            "sender_id": "user_1",
        },
        source="telegram.channel",
        subject="chat_1",
        text="失败任务",
        force_execute=True,
    )
    await asyncio.sleep(0.05)

    conversation = gateway_context.list_conversations(provider="telegram")[0]
    assert conversation["active_runtime_session_id"] == first["runtime_session_id"]
    assert conversation["active_runtime_session_status"] == "failed"

    second = await gateway_context.ingest_message(
        provider="telegram",
        event_payload={
            "instance_id": "tg-main",
            "bot_id": "bot_1",
            "chat_id": "chat_1",
            "chat_type": "private",
            "sender_id": "user_1",
        },
        source="telegram.channel",
        subject="chat_1",
        text="恢复后的任务",
        force_execute=True,
    )
    await asyncio.sleep(0.05)

    assert second["runtime_session_id"] != first["runtime_session_id"]
    assert second.get("forked_from_session_id") is None

    conversation = gateway_context.list_conversations(provider="telegram")[0]
    assert conversation["active_runtime_session_id"] == second["runtime_session_id"]
    assert conversation["active_runtime_session_status"] == "idle"


@pytest.mark.asyncio
async def test_gateway_context_sends_immediate_ack_before_final_result(tmp_path: Path):
    db_path = tmp_path / "events.db"
    rules_path = tmp_path / "rules.json"
    _write_rules(rules_path)

    async def _task_runner(**kwargs: Any) -> dict[str, Any]:
        await asyncio.sleep(0.01)
        return {
            "status": "success",
            "task": kwargs.get("task"),
            "session_id": kwargs.get("session_id"),
            "agent_id": kwargs.get("agent_id"),
            "final_response": "done",
            "runtime_events": [],
            "error": None,
        }

    config_store = RuntimeConfigStore(db_path=str(db_path))
    gateway_context = GatewayContextService(
        db_path=str(db_path),
        config_store=config_store,
        task_runner=_task_runner,
        runtime_db_path=str(db_path),
        rules_path=str(rules_path),
    )

    delivered: list[tuple[str, dict[str, Any]]] = []

    async def _on_result(text: str, ctx: dict[str, Any]) -> bool:
        delivered.append((text, ctx))
        return True

    await gateway_context.ingest_message(
        provider="telegram",
        event_payload={
            "bot_id": "bot_1",
            "chat_id": "chat_1",
            "chat_type": "private",
            "sender_id": "user_1",
        },
        source="telegram.channel",
        subject="chat_1",
        text="你好",
        force_execute=True,
        on_result=_on_result,
    )

    await asyncio.sleep(0.05)
    assert len(delivered) >= 2
    assert delivered[0][0] == "已收到，正在处理。"
    assert delivered[0][1]["status"] == "received"
    assert delivered[-1][0] == "done"


@pytest.mark.asyncio
async def test_gateway_context_can_disable_immediate_ack_via_gateway_config(tmp_path: Path):
    db_path = tmp_path / "events.db"
    rules_path = tmp_path / "rules.json"
    _write_rules(rules_path)

    async def _task_runner(**kwargs: Any) -> dict[str, Any]:
        return {
            "status": "success",
            "task": kwargs.get("task"),
            "session_id": kwargs.get("session_id"),
            "agent_id": kwargs.get("agent_id"),
            "final_response": "done",
            "runtime_events": [],
            "error": None,
        }

    config_store = RuntimeConfigStore(db_path=str(db_path))
    config_store.upsert_gateway_config(
        "telegram",
        {
            "isActive": True,
            "config": {
                "sendImmediateAck": False,
            },
        },
    )
    gateway_context = GatewayContextService(
        db_path=str(db_path),
        config_store=config_store,
        task_runner=_task_runner,
        runtime_db_path=str(db_path),
        rules_path=str(rules_path),
    )

    delivered: list[tuple[str, dict[str, Any]]] = []

    async def _on_result(text: str, ctx: dict[str, Any]) -> bool:
        delivered.append((text, ctx))
        return True

    await gateway_context.ingest_message(
        provider="telegram",
        event_payload={
            "bot_id": "bot_1",
            "chat_id": "chat_1",
            "chat_type": "private",
            "sender_id": "user_1",
        },
        source="telegram.channel",
        subject="chat_1",
        text="你好",
        force_execute=True,
        on_result=_on_result,
    )

    await asyncio.sleep(0.02)
    assert len(delivered) == 1
    assert delivered[0][0] == "done"


@pytest.mark.asyncio
async def test_gateway_manager_notify_routes_by_gateway_id_for_telegram(tmp_path: Path):
    db_path = tmp_path / "events.db"
    rules_path = tmp_path / "rules.json"
    _write_rules(rules_path)

    sent: list[dict[str, Any]] = []

    async def _send(token: str, payload: dict[str, Any], timeout: float) -> None:
        sent.append({"token": token, "payload": payload, "timeout": timeout})

    manager = _build_manager(db_path=db_path, rules_path=rules_path, telegram_send_fn=_send)
    manager.upsert_gateway_config(
        "telegram",
        {
            "isActive": True,
            "config": {
                "botToken": "123456:abc",
            },
        },
    )
    item = manager.get_gateway_config("telegram")

    await manager.handle_runtime_notify_payload(
        {
            "summary": "notify by gateway id",
            "gateway_id": f"telegram:{item['id']}:-200002",
        }
    )
    assert len(sent) == 1
    assert sent[0]["payload"]["chat_id"] == "-200002"
    assert sent[0]["payload"]["text"] == "notify by gateway id"


@pytest.mark.asyncio
async def test_gateway_manager_discord_test_send_and_notify(tmp_path: Path):
    db_path = tmp_path / "events.db"
    rules_path = tmp_path / "rules.json"
    _write_rules(rules_path)

    sent: list[dict[str, Any]] = []

    async def _discord_send(
        token: str,
        channel_id: str,
        payload: dict[str, Any],
        files,
        timeout: float,
    ) -> None:
        sent.append(
            {
                "token": token,
                "channel_id": channel_id,
                "payload": payload,
                "files": files,
                "timeout": timeout,
            }
        )

    manager = _build_manager(
        db_path=db_path,
        rules_path=rules_path,
        discord_send_fn=_discord_send,
    )
    created = manager.create_gateway_instance(
        {
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
            },
        }
    )
    assert created["status"] == "ready"
    assert created["config"]["botToken"] == "***"

    result = await manager.test_gateway("discord", {"text": "hello discord", "channelId": "chan_002"})
    assert result["sent"] is True
    assert sent[-1]["channel_id"] == "chan_002"
    assert sent[-1]["payload"]["content"] == "hello discord"

    await manager.handle_runtime_notify_payload(
        {
            "summary": "notify by gateway id",
            "gateway_id": f"discord:{created['id']}:chan_003",
        }
    )
    assert sent[-1]["channel_id"] == "chan_003"
    assert sent[-1]["payload"]["content"] == "notify by gateway id"


@pytest.mark.asyncio
async def test_gateway_manager_feishu_sdk_test_send(tmp_path: Path):
    db_path = tmp_path / "events.db"
    rules_path = tmp_path / "rules.json"
    _write_rules(rules_path)

    calls: list[dict[str, Any]] = []

    async def _sdk_send(
        app_id: str,
        app_secret: str,
        receive_id_type: str,
        receive_id: str,
        text: str,
        domain: str | None,
    ) -> bool:
        calls.append(
            {
                "app_id": app_id,
                "app_secret": app_secret,
                "receive_id_type": receive_id_type,
                "receive_id": receive_id,
                "text": text,
                "domain": domain,
            }
        )
        return True

    manager = _build_manager(
        db_path=db_path,
        rules_path=rules_path,
        feishu_sdk_send_fn=_sdk_send,
    )
    updated = manager.upsert_gateway_config(
        "feishu",
        {
            "isActive": True,
            "config": {
                "sdkEnabled": True,
                "appId": "cli_test",
                "appSecret": "secret_test",
                "receiveIdType": "chat_id",
                "defaultReceiveId": "oc_test_chat",
                "sdkDomain": "feishu",
            },
        },
    )
    assert updated["status"] == "ready"
    assert updated["config"]["appSecret"] == "***"

    result = await manager.test_gateway("feishu", {"title": "SDK", "content": "hello sdk", "channel": "default"})
    assert result["sent"] is True
    assert len(calls) == 1
    assert calls[0]["app_id"] == "cli_test"
    assert calls[0]["receive_id"] == "oc_test_chat"
    assert "hello sdk" in calls[0]["text"]


@pytest.mark.asyncio
async def test_gateway_manager_test_gateway_telegram_with_files(tmp_path: Path):
    db_path = tmp_path / "events.db"
    rules_path = tmp_path / "rules.json"
    _write_rules(rules_path)
    file_path = tmp_path / "demo.pdf"
    file_path.write_bytes(b"%PDF-1.4 gateway test")

    sent_json: list[dict[str, Any]] = []
    sent_doc: list[dict[str, Any]] = []

    async def _send_json(token: str, payload: dict[str, Any], timeout: float) -> None:
        sent_json.append({"token": token, "payload": payload, "timeout": timeout})

    async def _send_doc(token: str, data: dict[str, Any], file_upload, timeout: float) -> None:
        sent_doc.append({"token": token, "data": data, "file_upload": file_upload, "timeout": timeout})

    manager = _build_manager(
        db_path=db_path,
        rules_path=rules_path,
        telegram_send_fn=_send_json,
        telegram_send_document_fn=_send_doc,
    )
    manager.upsert_gateway_config(
        "telegram",
        {
            "isActive": True,
            "config": {
                "botToken": "123456:abc",
            },
        },
    )
    result = await manager.test_gateway(
        "telegram",
        {
            "text": "gateway file test",
            "chat_id": "-100001",
            "files": [{"local_path": str(file_path), "filename": "demo.pdf", "mime_type": "application/pdf"}],
        },
    )
    assert result["sent"] is True
    assert sent_json == []
    assert len(sent_doc) == 1
    assert sent_doc[0]["data"]["chat_id"] == "-100001"


@pytest.mark.asyncio
async def test_gateway_manager_telegram_ingest_with_addressing_policy(tmp_path: Path):
    db_path = tmp_path / "events.db"
    rules_path = tmp_path / "rules.json"
    _write_rules(rules_path)

    sent: list[dict[str, Any]] = []

    async def _send(token: str, payload: dict[str, Any], timeout: float) -> None:
        sent.append({"token": token, "payload": payload, "timeout": timeout})

    manager = _build_manager(db_path=db_path, rules_path=rules_path, telegram_send_fn=_send)
    manager.upsert_gateway_config(
        "telegram",
        {
            "isActive": True,
            "config": {
                "botToken": "123456:abc",
                "addressingPolicy": {"mode": "mention_only", "executeOnUnaddressed": False},
            },
        },
    )

    no_exec = await manager.ingest_telegram_webhook(
        {
            "update_id": 1,
            "message": {
                "message_id": 100,
                "chat": {"id": -100001, "type": "supergroup"},
                "from": {"id": 7788},
                "text": "hello semibot",
            },
        },
        headers={},
    )
    assert no_exec["accepted"] is True
    assert no_exec["should_execute"] is False
    assert no_exec["task_run_id"] is None
    await asyncio.sleep(0.05)
    assert sent == []

    with_exec = await manager.ingest_telegram_webhook(
        {
            "update_id": 2,
            "message": {
                "message_id": 101,
                "chat": {"id": -100001, "type": "supergroup"},
                "from": {"id": 7788},
                "text": "@semibot hello again",
                "entities": [{"type": "mention", "offset": 0, "length": 8}],
            },
        },
        headers={},
    )
    assert with_exec["accepted"] is True
    assert with_exec["should_execute"] is True
    assert with_exec["task_run_id"] is not None

    await asyncio.sleep(0.05)
    assert sent[-1]["payload"]["chat_id"] == "-100001"
    assert "@semibot hello again" in sent[-1]["payload"]["text"]
    assert "gateway_id=telegram:" in sent[-1]["payload"]["text"]

    convs = manager.list_gateway_conversations(provider="telegram", limit=10)["data"]
    assert len(convs) == 1
    conv_id = convs[0]["conversation_id"]
    runs = manager.list_gateway_conversation_runs(conv_id, limit=10)["data"]
    assert len(runs) == 1


@pytest.mark.asyncio
async def test_gateway_manager_text_approval_command(tmp_path: Path):
    db_path = tmp_path / "events.db"
    rules_path = tmp_path / "rules.json"
    _write_rules(rules_path)
    manager = _build_manager(db_path=db_path, rules_path=rules_path)

    event = Event(
        event_id="evt_fund_1",
        event_type="fund.transfer",
        source="test",
        subject="session_a",
        payload={"amount": 12000, "session_id": "session_a"},
    )
    await manager.engine.emit(event)

    pending = manager.engine.list_approvals(status="pending", limit=10)
    assert len(pending) == 1
    approval_id = pending[0].approval_id

    result = await manager.handle_text_approval_command(
        text=f"同意 {approval_id}",
        source="telegram.gateway",
        subject="session_a",
        trace_payload={"from": "test"},
    )
    assert result is not None
    assert result["resolved"] is True
    assert result["status"] == "approved"
    assert result["approval_ids"] == [approval_id]

    approved = manager.engine.list_approvals(status="approved", limit=10)
    assert len(approved) == 1
    assert approved[0].approval_id == approval_id


@pytest.mark.asyncio
async def test_gateway_manager_text_approval_command_approves_all_in_subject_scope(tmp_path: Path):
    db_path = tmp_path / "events.db"
    rules_path = tmp_path / "rules.json"
    _write_rules(rules_path)
    manager = _build_manager(db_path=db_path, rules_path=rules_path)

    for idx in range(2):
        manager.engine.store.insert_approval(
            ApprovalRequest(
                approval_id=f"appr_{uuid4().hex[:12]}",
                rule_id="rule_high",
                event_id=f"evt_fund_scope_{idx}",
                risk_level="high",
                context={"chat_id": "chat_scope_1", "tool_name": "file_io", "action": "read"},
                status="pending",
                created_at=datetime.now(UTC),
            )
        )

    pending = manager.engine.list_approvals(status="pending", limit=10)
    assert len(pending) == 2

    result = await manager.handle_text_approval_command(
        text="同意",
        source="telegram.gateway",
        subject="chat_scope_1",
        trace_payload={"from": "test"},
    )
    assert result is not None
    assert result["resolved"] is True
    assert result["resolved_count"] == 2
    assert len(result["approval_ids"]) == 2

    approved = manager.engine.list_approvals(status="approved", limit=10)
    assert len(approved) == 2


@pytest.mark.asyncio
async def test_gateway_manager_text_approval_command_uses_approval_scope_hint(tmp_path: Path):
    db_path = tmp_path / "events.db"
    rules_path = tmp_path / "rules.json"
    _write_rules(rules_path)
    manager = _build_manager(db_path=db_path, rules_path=rules_path)

    scope_id = "gmsg_scope_1"
    other_scope_id = "gmsg_scope_2"
    for item_scope in (scope_id, scope_id, other_scope_id):
        manager.engine.store.insert_approval(
            ApprovalRequest(
                approval_id=f"appr_{uuid4().hex[:12]}",
                rule_id="tool.file_io",
                event_id=f"{item_scope}:{uuid4().hex[:8]}",
                risk_level="high",
                context={
                    "tool_name": "file_io",
                    "action": "read",
                    "approval_scope_id": item_scope,
                },
                status="pending",
                created_at=datetime.now(UTC),
            )
        )

    pending = manager.engine.list_approvals(status="pending", limit=20)
    assert len(pending) == 3

    result = await manager.handle_text_approval_command(
        text="同意",
        source="telegram.gateway",
        subject="-100001",
        trace_payload={"approval_scope_ids": [scope_id]},
    )
    assert result is not None
    assert result["resolved"] is True
    assert result["resolved_count"] == 2

    approved = manager.engine.list_approvals(status="approved", limit=20)
    assert len(approved) == 2
    assert all((item.context or {}).get("approval_scope_id") == scope_id for item in approved)

    pending_after = manager.engine.list_approvals(status="pending", limit=20)
    assert len(pending_after) == 1
    assert (pending_after[0].context or {}).get("approval_scope_id") == other_scope_id


@pytest.mark.asyncio
async def test_gateway_manager_multi_instance_create_update_delete(tmp_path: Path):
    db_path = tmp_path / "events.db"
    rules_path = tmp_path / "rules.json"
    _write_rules(rules_path)
    manager = _build_manager(db_path=db_path, rules_path=rules_path)

    created = manager.create_gateway_instance(
        {
            "provider": "telegram",
            "instanceKey": "tg-ops",
            "displayName": "Telegram Ops",
            "isActive": True,
            "config": {"botToken": "987654:token_ops"},
        }
    )
    assert created["provider"] == "telegram"
    assert created["instanceKey"] == "tg-ops"
    assert created["displayName"] == "Telegram Ops"

    listing = manager.list_gateway_instances("telegram")
    keys = {item.get("instanceKey") for item in listing}
    assert "tg-ops" in keys

    updated = manager.update_gateway_instance(
        str(created["id"]),
        {
            "displayName": "Telegram Ops V2",
            "isDefault": True,
            "config": {
                "botBindings": [
                    {"botId": "987654", "agentId": "ops"},
                    {"botId": "987654", "agentId": "ops-v2"},
                    {"botId": "987655", "agentId": "risk"},
                    {"botId": "987656", "agentId": ""},
                ],
            },
        },
    )
    assert updated["displayName"] == "Telegram Ops V2"
    assert updated["isDefault"] is True
    assert "allowedChatIds" not in updated["config"]
    assert "chatBindings" not in updated["config"]
    assert updated["config"]["botBindings"] == [
        {"botId": "987654", "agentId": "ops-v2"},
        {"botId": "987655", "agentId": "risk"},
    ]

    removed = manager.delete_gateway_instance(str(created["id"]))
    assert removed["deleted"] is True
