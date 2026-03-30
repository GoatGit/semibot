"""Outbound Telegram notifier for key Semibot events."""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Any

import httpx

from src.events.models import Event

SendFn = Callable[[str, dict[str, Any], float], Awaitable[Any]]
SendDocumentFn = Callable[[str, dict[str, Any], Any | None, float], Awaitable[Any]]


async def default_send_json(token: str, payload: dict[str, Any], timeout: float) -> None:
    url = f"https://api.telegram.org/bot{token}/sendMessage"
    async with httpx.AsyncClient(timeout=timeout) as client:
        response = await client.post(url, json=payload)
        try:
            return response.json()
        except Exception:
            return None


async def default_send_document(
    token: str,
    data: dict[str, Any],
    file_upload: dict[str, Any] | None,
    timeout: float,
) -> None:
    url = f"https://api.telegram.org/bot{token}/sendDocument"
    async with httpx.AsyncClient(timeout=timeout) as client:
        if file_upload:
            response = await client.post(url, data=data, files={"document": file_upload})
        else:
            response = await client.post(url, data=data)
        try:
            return response.json()
        except Exception:
            return None


class TelegramNotifier:
    """Convert selected internal events into Telegram messages."""

    def __init__(
        self,
        *,
        bot_token: str | None = None,
        default_chat_id: str | None = None,
        timeout: float = 10.0,
        send_fn: SendFn | None = None,
        subscribed_event_types: set[str] | None = None,
        parse_mode: str | None = None,
        disable_link_preview: bool = False,
        send_document_fn: SendDocumentFn | None = None,
    ):
        self.bot_token = bot_token
        self.default_chat_id = default_chat_id
        self.timeout = timeout
        self.send_fn = send_fn or default_send_json
        self.send_document_fn = send_document_fn or default_send_document
        self._last_delivery_metadata: dict[str, Any] = {}
        self.subscribed_event_types = subscribed_event_types or {
            "approval.requested",
            "task.completed",
            "rule.run_agent.executed",
        }
        self.parse_mode = parse_mode
        self.disable_link_preview = disable_link_preview

    @staticmethod
    def _split_text(text: str, max_len: int = 3500) -> list[str]:
        raw = text or ""
        if len(raw) <= max_len:
            return [raw]
        chunks: list[str] = []
        remaining = raw
        while len(remaining) > max_len:
            cut = remaining.rfind("\n", 0, max_len)
            if cut <= 0:
                cut = max_len
            chunks.append(remaining[:cut].strip())
            remaining = remaining[cut:].lstrip()
        if remaining:
            chunks.append(remaining)
        return [chunk for chunk in chunks if chunk]

    async def send_message(self, *, text: str, chat_id: str | None = None) -> bool:
        token = self.bot_token
        target_chat_id = chat_id or self.default_chat_id
        if not token or not target_chat_id:
            return False

        self._last_delivery_metadata = {}
        chunks = self._split_text(text)
        if not chunks:
            return False
        for chunk in chunks:
            payload: dict[str, Any] = {
                "chat_id": target_chat_id,
                "text": chunk,
                "disable_web_page_preview": self.disable_link_preview,
            }
            if self.parse_mode:
                payload["parse_mode"] = self.parse_mode
            response = await self.send_fn(token, payload, self.timeout)
            self._remember_delivery_metadata(response, preserve_existing=True)
        return True

    async def send_notify_payload(self, payload: dict[str, Any]) -> bool:
        text = str(
            payload.get("content")
            or payload.get("summary")
            or payload.get("message")
            or f"event_type={payload.get('event_type')}"
        )
        chat_id = str(payload.get("chat_id")) if payload.get("chat_id") else None
        files_raw = payload.get("files")
        if not isinstance(files_raw, list):
            files_raw = payload.get("attachments")
        files = [item for item in files_raw if isinstance(item, dict)] if isinstance(files_raw, list) else []
        if not files:
            return await self.send_message(text=text, chat_id=chat_id)

        token = self.bot_token
        target_chat_id = chat_id or self.default_chat_id
        if not token or not target_chat_id:
            return False

        self._last_delivery_metadata = {}
        sent_any = False
        caption_text = text.strip()
        for idx, file_item in enumerate(files):
            local_path = str(
                file_item.get("local_path")
                or file_item.get("path")
                or ""
            ).strip()
            file_url = str(file_item.get("url") or file_item.get("file_url") or "").strip()
            filename = str(file_item.get("filename") or file_item.get("name") or "").strip()
            mime_type = str(file_item.get("mime_type") or "application/octet-stream").strip()

            data: dict[str, Any] = {"chat_id": target_chat_id}
            if caption_text and idx == 0:
                data["caption"] = caption_text[:900]
                if self.parse_mode:
                    data["parse_mode"] = self.parse_mode

            if local_path:
                path = Path(local_path)
                if path.is_file():
                    with path.open("rb") as fh:
                        upload_name = filename or path.name
                        response = await self.send_document_fn(
                            token,
                            data,
                            (upload_name, fh, mime_type),
                            self.timeout,
                        )
                        self._remember_delivery_metadata(response, preserve_existing=True)
                        sent_any = True
                    continue

            if file_url:
                data["document"] = file_url
                response = await self.send_document_fn(token, data, None, self.timeout)
                self._remember_delivery_metadata(response, preserve_existing=True)
                sent_any = True

        if not sent_any:
            return await self.send_message(text=text, chat_id=target_chat_id)
        return True

    def last_delivery_metadata(self) -> dict[str, Any]:
        return dict(self._last_delivery_metadata)

    def _remember_delivery_metadata(self, response: Any, *, preserve_existing: bool = False) -> None:
        payload = response if isinstance(response, dict) else {}
        result = payload.get("result") if isinstance(payload.get("result"), dict) else {}
        message_id = result.get("message_id") or payload.get("message_id")
        chat = result.get("chat") if isinstance(result.get("chat"), dict) else {}
        thread_id = result.get("message_thread_id") or payload.get("message_thread_id")
        if preserve_existing and self._last_delivery_metadata.get("channel_message_id"):
            return
        metadata: dict[str, Any] = {}
        if message_id is not None:
            metadata["channel_message_id"] = str(message_id)
        if thread_id is not None:
            metadata["channel_thread_id"] = str(thread_id)
        if chat.get("id") is not None:
            metadata["channel_target_id"] = str(chat.get("id"))
        if metadata:
            self._last_delivery_metadata = metadata

    async def handle_event(self, event: Event) -> None:
        if event.event_type not in self.subscribed_event_types:
            return

        payload = event.payload if isinstance(event.payload, dict) else {}
        if event.event_type == "approval.requested":
            context = payload.get("context")
            context_map = context if isinstance(context, dict) else {}
            approval_id = str(payload.get("approval_id") or event.subject or "").strip() or "unknown"
            risk = str(payload.get("risk_level") or "").strip() or "high"
            tool_name = str(context_map.get("tool_name") or "").strip()
            action = str(context_map.get("action") or "").strip()
            target = str(context_map.get("target") or "").strip()
            lines = [
                "需要审批后才能继续执行：",
                f"- 审批ID: {approval_id}",
                f"- 风险: {risk}",
            ]
            if tool_name:
                lines.append(f"- 工具: {tool_name}")
            if action:
                lines.append(f"- 动作: {action}")
            if target:
                lines.append(f"- 目标: {target}")
            lines.append("回复“同意”可一次通过当前会话待审批，或发送 /approve <id>。")
            text = "\n".join(lines)
        else:
            text = (
                f"*Semibot* `{event.event_type}`\n"
                f"subject: `{event.subject or payload.get('session_id') or 'n/a'}`\n"
                f"summary: {payload.get('summary') or payload.get('awaiting_approval_message') or payload.get('final_response') or payload.get('message') or '任务已完成。'}"
            )
        chat_id = str(payload.get("chat_id")) if payload.get("chat_id") else None
        await self.send_message(text=text, chat_id=chat_id)
