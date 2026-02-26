"""Outbound Feishu notifier for key Semibot events."""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import Any

import httpx

from src.events.models import Event

SendFn = Callable[[str, dict[str, Any], float], Awaitable[None]]


class _SafeDict(dict[str, str]):
    def __missing__(self, key: str) -> str:
        return "{" + key + "}"


async def default_send_json(url: str, payload: dict[str, Any], timeout: float) -> None:
    """POST JSON payload to Feishu webhook URL."""
    async with httpx.AsyncClient(timeout=timeout) as client:
        await client.post(url, json=payload)


class FeishuNotifier:
    """Convert selected internal events into Feishu webhook messages."""

    def __init__(
        self,
        *,
        webhook_url: str | None = None,
        webhook_urls: dict[str, str] | None = None,
        timeout: float = 10.0,
        send_fn: SendFn | None = None,
        subscribed_event_types: set[str] | None = None,
        templates: dict[str, dict[str, str]] | None = None,
    ):
        self.webhook_url = webhook_url
        self.webhook_urls = webhook_urls or {}
        self.timeout = timeout
        self.send_fn = send_fn or default_send_json
        self.subscribed_event_types = subscribed_event_types or {
            "approval.requested",
            "task.completed",
            "rule.run_agent.executed",
        }
        self.templates = templates or {}

    async def send_markdown(self, *, title: str, content: str, channel: str = "default") -> bool:
        webhook = self._resolve_webhook(channel)
        if not webhook:
            return False
        payload = {
            "msg_type": "interactive",
            "card": {
                "header": {"title": {"tag": "plain_text", "content": title}},
                "elements": [{"tag": "markdown", "content": content}],
            },
        }
        await self.send_fn(webhook, payload, self.timeout)
        return True

    async def send_notify_payload(self, payload: dict[str, Any]) -> bool:
        channel = str(payload.get("channel") or "default")
        title = str(payload.get("title") or "Semibot 通知")
        content = str(
            payload.get("content")
            or payload.get("summary")
            or payload.get("message")
            or f"event_type={payload.get('event_type')}"
        )
        return await self.send_markdown(title=title, content=content, channel=channel)

    async def handle_event(self, event: Event) -> None:
        if event.event_type not in self.subscribed_event_types:
            return

        channel = "default"
        if isinstance(event.payload, dict):
            channel = str(event.payload.get("channel") or "default")
        webhook = self._resolve_webhook(channel)
        if not webhook:
            return

        if event.event_type == "approval.requested":
            payload = self._approval_card(event)
        else:
            payload = self._result_card(event)
        await self.send_fn(webhook, payload, self.timeout)

    def _resolve_webhook(self, channel: str) -> str | None:
        if channel and channel in self.webhook_urls:
            return self.webhook_urls[channel]
        if "default" in self.webhook_urls:
            return self.webhook_urls["default"]
        return self.webhook_url

    def _approval_card(self, event: Event) -> dict[str, Any]:
        context = self._template_context(event)
        return self._build_card(
            event,
            fallback_title="Semibot 审批请求",
            fallback_content=(
                f"审批ID: {context['approval_id']}\n"
                f"规则: {context['rule_id']}\n"
                f"事件: {context['source_event_id']}\n"
                f"风险: {context['risk_level']}\n"
                "请在 Semibot 审批入口处理：`semibot approvals list`"
            ),
        )

    def _result_card(self, event: Event) -> dict[str, Any]:
        context = self._template_context(event)
        content = (
            f"类型: {context['event_type']}\n"
            f"对象: {context['subject']}\n"
            f"trace_id: {context['trace_id']}\n"
            f"摘要: {context['summary']}"
        )
        return self._build_card(event, fallback_title="Semibot 执行结果", fallback_content=content)

    def _build_card(self, event: Event, *, fallback_title: str, fallback_content: str) -> dict[str, Any]:
        context = self._template_context(event)
        template = self.templates.get(event.event_type) or {}
        title_template = template.get("title", fallback_title)
        content_template = template.get("content", fallback_content)

        safe_context = _SafeDict(context)
        title = title_template.format_map(safe_context)
        content = content_template.format_map(safe_context)
        return {
            "msg_type": "interactive",
            "card": {
                "header": {"title": {"tag": "plain_text", "content": title}},
                "elements": [{"tag": "markdown", "content": content}],
            },
        }

    def _template_context(self, event: Event) -> dict[str, str]:
        payload = event.payload if isinstance(event.payload, dict) else {}
        summary = str(
            payload.get("summary")
            or payload.get("final_response")
            or payload.get("result")
            or payload.get("message")
            or "任务已完成。"
        )
        return {
            "event_type": event.event_type,
            "event_id": event.event_id,
            "subject": str(event.subject or payload.get("session_id") or "n/a"),
            "trace_id": str(payload.get("trace_id") or "n/a"),
            "approval_id": str(payload.get("approval_id") or event.subject or ""),
            "rule_id": str(payload.get("rule_id") or ""),
            "source_event_id": str(payload.get("event_id") or ""),
            "risk_level": str(payload.get("risk_level") or event.risk_hint or "unknown"),
            "summary": summary,
        }
