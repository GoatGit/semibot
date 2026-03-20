"""Tests for outbound Feishu notifier behavior."""

from typing import Any

import pytest

from src.events.models import Event
from src.server.feishu_notifier import FeishuNotifier


@pytest.mark.asyncio
async def test_feishu_notifier_sends_approval_card():
    sent: list[dict[str, Any]] = []

    async def _send(url: str, payload: dict[str, Any], timeout: float) -> None:
        sent.append({"url": url, "payload": payload, "timeout": timeout})

    notifier = FeishuNotifier(webhook_url="https://example.com/hook", send_fn=_send)
    await notifier.handle_event(
        Event(
            event_id="evt1",
            event_type="approval.requested",
            source="test",
            subject="appr_1",
            payload={"approval_id": "appr_1", "rule_id": "rule_1", "event_id": "evt_x", "risk_level": "high"},
        )
    )

    assert len(sent) == 1
    assert sent[0]["url"] == "https://example.com/hook"
    assert sent[0]["payload"]["msg_type"] == "interactive"
    markdown = sent[0]["payload"]["card"]["elements"][0]["content"]
    assert "appr_1" in markdown
    assert "high" in markdown


@pytest.mark.asyncio
async def test_feishu_notifier_sends_result_card():
    sent: list[dict[str, Any]] = []

    async def _send(url: str, payload: dict[str, Any], timeout: float) -> None:
        sent.append(payload)

    notifier = FeishuNotifier(webhook_url="https://example.com/hook", send_fn=_send)
    await notifier.handle_event(
        Event(
            event_id="evt2",
            event_type="task.completed",
            source="runtime",
            subject="session_1",
            payload={"trace_id": "trace_1", "final_response": "done"},
        )
    )

    assert len(sent) == 1
    content = sent[0]["card"]["elements"][0]["content"]
    assert "trace_1" in content
    assert "done" in content


@pytest.mark.asyncio
async def test_feishu_notifier_ignores_unrelated_events():
    sent: list[dict[str, Any]] = []

    async def _send(url: str, payload: dict[str, Any], timeout: float) -> None:
        sent.append(payload)

    notifier = FeishuNotifier(webhook_url="https://example.com/hook", send_fn=_send)
    await notifier.handle_event(
        Event(
            event_id="evt3",
            event_type="tool.exec.completed",
            source="runtime",
            subject=None,
            payload={},
        )
    )
    assert sent == []


@pytest.mark.asyncio
async def test_feishu_notifier_templates_and_channel_routing():
    sent: list[dict[str, Any]] = []

    async def _send(url: str, payload: dict[str, Any], timeout: float) -> None:
        sent.append({"url": url, "payload": payload, "timeout": timeout})

    notifier = FeishuNotifier(
        webhook_urls={"default": "https://default/hook", "ops": "https://ops/hook"},
        templates={
            "task.completed": {
                "title": "完成: {event_type}",
                "content": "对象={subject} trace={trace_id}",
            }
        },
        send_fn=_send,
    )
    await notifier.handle_event(
        Event(
            event_id="evt4",
            event_type="task.completed",
            source="runtime",
            subject="session_ops",
            payload={"trace_id": "trace_ops", "channel": "ops"},
        )
    )

    assert len(sent) == 1
    assert sent[0]["url"] == "https://ops/hook"
    assert sent[0]["payload"]["card"]["header"]["title"]["content"] == "完成: task.completed"
    content = sent[0]["payload"]["card"]["elements"][0]["content"]
    assert "trace_ops" in content
