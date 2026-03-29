"""iMessage outbound notifier.

First-pass contract:
- talks to a bridge service over HTTP (BlueBubbles-style adapter)
- sends text/file payloads to the bridge
- keeps channel plugin boundary stable even before a concrete bridge ships
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, Awaitable, Callable

import httpx

from src.events.models import Event

SendFn = Callable[[str, dict[str, Any], float], Awaitable[None]]


class IMessageNotifier:
    def __init__(
        self,
        *,
        bridge_url: str | None = None,
        default_handle: str | None = None,
        subscribed_event_types: set[str] | None = None,
        send_fn: SendFn | None = None,
    ) -> None:
        self.bridge_url = str(bridge_url or "").strip() or None
        self.default_handle = str(default_handle or "").strip() or None
        self.subscribed_event_types = subscribed_event_types or {
            "approval.requested",
            "task.completed",
            "rule.run_agent.executed",
        }
        self.send_fn = send_fn

    async def send_message(
        self,
        *,
        text: str,
        handle: str | None = None,
        files: list[dict[str, Any]] | None = None,
    ) -> bool:
        if not self.bridge_url:
            return False
        target_handle = str(handle or self.default_handle or "").strip()
        if not target_handle:
            return False
        normalized_files: list[dict[str, Any]] = []
        for item in files or []:
            if not isinstance(item, dict):
                continue
            local_path = str(item.get("local_path") or item.get("path") or "").strip()
            if not local_path or not Path(local_path).is_file():
                continue
            normalized_files.append(
                {
                    "local_path": local_path,
                    "filename": str(item.get("filename") or Path(local_path).name),
                    "mime_type": str(item.get("mime_type") or "application/octet-stream"),
                }
            )
        payload = {
            "handle": target_handle,
            "text": str(text or "").strip(),
            "files": normalized_files,
        }
        timeout_seconds = 10.0
        if self.send_fn is not None:
            await self.send_fn(self.bridge_url.rstrip("/"), payload, timeout_seconds)
        else:
            timeout = httpx.Timeout(timeout_seconds, connect=5.0)
            async with httpx.AsyncClient(timeout=timeout) as client:
                response = await client.post(f"{self.bridge_url.rstrip('/')}/messages/send", json=payload)
                response.raise_for_status()
        return True

    async def send_notify_payload(self, payload: dict[str, Any]) -> bool:
        text = str(
            payload.get("content")
            or payload.get("summary")
            or payload.get("message")
            or payload.get("text")
            or f"event_type={payload.get('event_type')}"
        )
        handle = str(
            payload.get("chat_id")
            or payload.get("chatId")
            or payload.get("handle")
            or self.default_handle
            or ""
        ).strip()
        files_raw = payload.get("files")
        if not isinstance(files_raw, list):
            files_raw = payload.get("attachments")
        files_meta = [item for item in files_raw if isinstance(item, dict)] if isinstance(files_raw, list) else []
        return await self.send_message(text=text, handle=handle or None, files=files_meta)

    async def handle_event(self, event: Event) -> None:
        if event.event_type not in self.subscribed_event_types:
            return
        payload = event.payload if isinstance(event.payload, dict) else {}
        if event.event_type == "approval.requested":
            context = payload.get("context")
            context_map = context if isinstance(context, dict) else {}
            approval_id = str(payload.get("approval_id") or event.subject or "").strip() or "unknown"
            lines = [
                "需要审批后才能继续执行：",
                f"- 审批ID: {approval_id}",
                f"- 风险: {str(payload.get('risk_level') or 'high')}",
            ]
            if str(context_map.get("tool_name") or "").strip():
                lines.append(f"- 工具: {context_map.get('tool_name')}")
            lines.append("回复“同意”可一次通过当前会话待审批，或发送 /approve <id>。")
            text = "\n".join(lines)
        else:
            text = str(
                payload.get("summary")
                or payload.get("awaiting_approval_message")
                or payload.get("final_response")
                or payload.get("message")
                or f"event_type={event.event_type}"
            )
        target_handle = str(payload.get("chat_id") or payload.get("handle") or "").strip() or None
        await self.send_message(text=text, handle=target_handle)
