"""WhatsApp outbound notifier skeleton.

Current scope:
- keeps channel plugin contract complete
- does not yet implement Baileys transport
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from src.events.models import Event
from src.gateway.channels.whatsapp.helpers import enqueue_outbound_command


class WhatsAppNotifier:
    def __init__(
        self,
        *,
        instance_id: str | None = None,
        session_name: str | None = None,
        default_chat_id: str | None = None,
        linked_phone: str | None = None,
        subscribed_event_types: set[str] | None = None,
    ) -> None:
        self.instance_id = str(instance_id or "").strip() or None
        self.session_name = str(session_name or "").strip() or None
        self.default_chat_id = str(default_chat_id or "").strip() or None
        self.linked_phone = str(linked_phone or "").strip() or None
        self.subscribed_event_types = subscribed_event_types or {
            "approval.requested",
            "task.completed",
            "rule.run_agent.executed",
        }

    async def send_message(
        self,
        *,
        text: str,
        chat_id: str | None = None,
        files: list[dict[str, Any]] | None = None,
    ) -> bool:
        if not self.instance_id:
            return False
        target_chat_id = str(chat_id or self.default_chat_id or self.linked_phone or "").strip()
        if not target_chat_id:
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
        enqueue_outbound_command(
            instance_id=self.instance_id,
            command={
                "type": "send_message",
                "chat_id": target_chat_id,
                "text": str(text or "").strip(),
                "files": normalized_files,
            },
        )
        return True

    async def send_notify_payload(self, payload: dict[str, Any]) -> bool:
        text = str(
            payload.get("content")
            or payload.get("summary")
            or payload.get("message")
            or payload.get("text")
            or f"event_type={payload.get('event_type')}"
        )
        target_chat_id = str(
            payload.get("chat_id")
            or payload.get("chatId")
            or payload.get("channel_id")
            or self.default_chat_id
            or self.linked_phone
            or ""
        ).strip()
        files_raw = payload.get("files")
        if not isinstance(files_raw, list):
            files_raw = payload.get("attachments")
        files_meta = [item for item in files_raw if isinstance(item, dict)] if isinstance(files_raw, list) else []
        return await self.send_message(text=text, chat_id=target_chat_id or None, files=files_meta)

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
                or payload.get("final_response")
                or payload.get("message")
                or f"event_type={event.event_type}"
            )
        target_chat_id = str(payload.get("chat_id") or payload.get("channel_id") or "").strip() or None
        await self.send_message(text=text, chat_id=target_chat_id)
