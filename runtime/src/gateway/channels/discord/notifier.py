"""Discord outbound notifier."""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Any

import json

import httpx

from src.events.models import Event

SendFn = Callable[[str, str, dict[str, Any], list[tuple[str, Any]] | None, float], Awaitable[Any]]


async def default_send_discord(
    bot_token: str,
    channel_id: str,
    payload: dict[str, Any],
    files: list[tuple[str, Any]] | None,
    timeout: float,
) -> None:
    url = f"https://discord.com/api/v10/channels/{channel_id}/messages"
    headers = {"Authorization": f"Bot {bot_token}"}
    async with httpx.AsyncClient(timeout=timeout) as client:
        if files:
            multipart_data = {"payload_json": json.dumps(payload, ensure_ascii=False)}
            resp = await client.post(url, headers=headers, data=multipart_data, files=files)
        else:
            resp = await client.post(url, headers=headers, json=payload)
    resp.raise_for_status()
    try:
        return resp.json()
    except Exception:
        return None


class DiscordNotifier:
    def __init__(
        self,
        *,
        bot_token: str | None = None,
        default_channel_id: str | None = None,
        timeout: float = 10.0,
        send_fn: SendFn | None = None,
        subscribed_event_types: set[str] | None = None,
    ) -> None:
        self.bot_token = str(bot_token or "").strip() or None
        self.default_channel_id = str(default_channel_id or "").strip() or None
        self.timeout = timeout
        self.send_fn = send_fn or default_send_discord
        self._last_delivery_metadata: dict[str, Any] = {}
        self.subscribed_event_types = subscribed_event_types or {
            "approval.requested",
            "task.completed",
            "rule.run_agent.executed",
        }

    @staticmethod
    def _split_text(text: str, max_len: int = 1800) -> list[str]:
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

    async def send_message(self, *, text: str, channel_id: str | None = None) -> bool:
        token = self.bot_token
        target_channel_id = str(channel_id or self.default_channel_id or "").strip()
        if not token or not target_channel_id:
            return False
        self._last_delivery_metadata = {}
        chunks = self._split_text(text)
        if not chunks:
            return False
        for chunk in chunks:
            response = await self.send_fn(token, target_channel_id, {"content": chunk}, None, self.timeout)
            self._remember_delivery_metadata(response, preserve_existing=True)
        return True

    async def send_notify_payload(self, payload: dict[str, Any]) -> bool:
        token = self.bot_token
        channel_id = str(
            payload.get("channel_id")
            or payload.get("channelId")
            or payload.get("chat_id")
            or self.default_channel_id
            or ""
        ).strip()
        if not token or not channel_id:
            return False
        text = str(
            payload.get("content")
            or payload.get("summary")
            or payload.get("message")
            or payload.get("text")
            or f"event_type={payload.get('event_type')}"
        )
        files_raw = payload.get("files")
        if not isinstance(files_raw, list):
            files_raw = payload.get("attachments")
        files_meta = [item for item in files_raw if isinstance(item, dict)] if isinstance(files_raw, list) else []
        if not files_meta:
            return await self.send_message(text=text, channel_id=channel_id)

        self._last_delivery_metadata = {}
        file_payload: dict[str, Any] = {"content": text}
        files: list[tuple[str, Any]] = []
        opened: list[Any] = []
        try:
            for idx, item in enumerate(files_meta):
                local_path = str(item.get("local_path") or item.get("path") or "").strip()
                if not local_path:
                    continue
                path = Path(local_path)
                if not path.is_file():
                    continue
                fh = path.open("rb")
                opened.append(fh)
                field_name = f"files[{idx}]"
                files.append((field_name, (str(item.get("filename") or path.name), fh, str(item.get("mime_type") or "application/octet-stream"))))
            if files:
                response = await self.send_fn(token, channel_id, file_payload, files, self.timeout)
                self._remember_delivery_metadata(response, preserve_existing=True)
                return True
        finally:
            for fh in opened:
                try:
                    fh.close()
                except Exception:
                    pass
        return await self.send_message(text=text, channel_id=channel_id)

    def last_delivery_metadata(self) -> dict[str, Any]:
        return dict(self._last_delivery_metadata)

    def _remember_delivery_metadata(self, response: Any, *, preserve_existing: bool = False) -> None:
        payload = response if isinstance(response, dict) else {}
        if preserve_existing and self._last_delivery_metadata.get("channel_message_id"):
            return
        message_id = payload.get("id") or payload.get("message_id")
        channel_id = payload.get("channel_id")
        metadata: dict[str, Any] = {}
        if message_id is not None:
            metadata["channel_message_id"] = str(message_id)
        if channel_id is not None:
            metadata["channel_target_id"] = str(channel_id)
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
        channel_id = str(payload.get("channel_id") or payload.get("chat_id") or "").strip() or None
        await self.send_message(text=text, channel_id=channel_id)
