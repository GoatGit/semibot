from __future__ import annotations

import json
import logging
import os
import re
from collections.abc import Mapping
from datetime import UTC, datetime
from pathlib import Path
from typing import TYPE_CHECKING, Any

from src.gateway.channels.shared import format_approval_notice, query_value

if TYPE_CHECKING:
    from src.gateway.manager import GatewayManager

logger = logging.getLogger(__name__)


def _sanitize_path_component(value: str) -> str:
    cleaned = re.sub(r"[^a-zA-Z0-9._-]+", "_", value.strip())
    return cleaned.strip("._") or "unknown"


def _query_value(query_params: Mapping[str, str] | None, *keys: str) -> str | None:
    return query_value(query_params, *keys)


def _query_value(query_params: Mapping[str, str] | None, *keys: str) -> str | None:
    if not query_params:
        return None
    for key in keys:
        value = str(query_params.get(key, "")).strip()
        if value:
            return value
    return None


def resolve_instance_for_ingest(
    manager: GatewayManager,
    *,
    query_params: Mapping[str, str] | None,
) -> dict[str, Any] | None:
    from src.gateway.manager import GatewayManagerError

    instance_id = _query_value(query_params, "instanceId", "instance_id")
    if instance_id:
        item = manager._get_instance(instance_id)  # noqa: SLF001
        if item and str(item.get("provider")) == "whatsapp":
            return item
        raise GatewayManagerError("gateway_instance_not_found", status_code=404)

    active_items = manager.list_provider_instances("whatsapp", active_only=True)
    if not active_items:
        return None
    if len(active_items) == 1:
        return active_items[0]
    raise GatewayManagerError("ambiguous_whatsapp_instance", status_code=409)


def channel_root_dir(instance_id: str) -> Path:
    safe_id = _sanitize_path_component(instance_id)
    base = Path(os.getenv("SEMIBOT_WHATSAPP_STATE_DIR", "~/.semibot/channels/whatsapp")).expanduser()
    root = base / safe_id
    root.mkdir(parents=True, exist_ok=True)
    return root


def auth_dir_for_instance(instance_id: str) -> Path:
    path = channel_root_dir(instance_id) / "auth"
    path.mkdir(parents=True, exist_ok=True)
    return path


def outbox_dir_for_instance(instance_id: str) -> Path:
    path = channel_root_dir(instance_id) / "outbox"
    path.mkdir(parents=True, exist_ok=True)
    return path


def inbound_dir_for_instance(instance_id: str) -> Path:
    path = channel_root_dir(instance_id) / "inbound"
    path.mkdir(parents=True, exist_ok=True)
    return path


async def resume_after_approval(
    manager: GatewayManager,
    *,
    target_instance: dict[str, Any] | None,
    event_payload: dict[str, Any],
) -> dict[str, Any]:
    chat_id = str(event_payload.get("chat_id") or "").strip()
    bot_id = str(event_payload.get("bot_id") or "").strip()
    instance_id = str(event_payload.get("instance_id") or (target_instance or {}).get("id") or "").strip()
    if not chat_id or not instance_id:
        return {"resumed": False, "reason": "missing_chat_or_instance_id"}

    gateway_key = manager.gateway_context._gateway_key(
        provider="whatsapp",
        instance_id=instance_id,
        chat_id=chat_id,
    )  # noqa: SLF001
    conversation = await manager.gateway_context.store.aget_or_create_conversation(
        provider="whatsapp",
        gateway_key=gateway_key,
        instance_id=instance_id,
        bot_id=bot_id,
        chat_id=chat_id,
    )
    messages = await manager.gateway_context.store.alist_context_messages(conversation["id"], limit=500)
    latest_user = next(
        (
            item
            for item in reversed(messages)
            if str(item.get("role") or "") == "user"
            and str(((item.get("metadata") if isinstance(item.get("metadata"), dict) else {}) or {}).get("source") or "")
            != "whatsapp.gateway.resume"
        ),
        None,
    )
    if latest_user is None:
        latest_user = next((item for item in reversed(messages) if str(item.get("role") or "") == "user"), None)
    if not latest_user:
        return {"resumed": False, "reason": "no_user_message", "conversation_id": conversation["id"]}

    content = str(latest_user.get("content") or "").strip()
    if not content:
        return {"resumed": False, "reason": "latest_user_message_empty", "conversation_id": conversation["id"]}

    metadata = latest_user.get("metadata")
    meta = metadata if isinstance(metadata, dict) else {}
    attachments = meta.get("attachments")
    resume_payload: dict[str, Any] = {
        "instance_id": instance_id,
        "chat_id": chat_id,
        "bot_id": bot_id,
        "sender_id": meta.get("sender_id"),
        "chat_type": str(meta.get("chat_type") or ""),
        "is_mention": True,
        "is_reply_to_bot": True,
        "attachments": attachments if isinstance(attachments, list) else [],
        "approval_scope_id": str(latest_user.get("id") or "").strip() or None,
    }

    async def _whatsapp_result_sender(reply_text: str, ctx: dict[str, Any]) -> bool:
        notifier = manager.build_whatsapp_notifier(target_instance)
        if not notifier:
            return False
        target_chat_id = str(ctx.get("chat_id") or "").strip() or chat_id
        return await notifier.send_notify_payload(
            {
                "content": reply_text,
                "chat_id": target_chat_id,
                "files": ctx.get("files") if isinstance(ctx, dict) else [],
            }
        )

    result = await manager.gateway_context.ingest_message(
        provider="whatsapp",
        event_payload=resume_payload,
        source="whatsapp.gateway.resume",
        subject=chat_id,
        text=content,
        agent_id=manager._gateway_agent_id("whatsapp", target_instance, event_payload=resume_payload),  # noqa: SLF001
        force_execute=True,
        on_result=_whatsapp_result_sender,
    )
    return {
        "resumed": True,
        "conversation_id": result.get("conversation_id"),
        "task_run_id": result.get("task_run_id"),
        "runtime_session_id": result.get("runtime_session_id"),
        "agent_id": result.get("agent_id"),
    }


async def handle_approval_followup(
    manager: GatewayManager,
    *,
    target_instance: dict[str, Any] | None,
    event_payload: dict[str, Any],
    approval_command: dict[str, Any],
) -> dict[str, Any] | None:
    chat_id_for_notice = str(event_payload.get("chat_id") or "").strip() or None
    if chat_id_for_notice:
        notifier = manager.build_whatsapp_notifier(target_instance)
        if notifier:
            try:
                resolved_count = int(approval_command.get("resolved_count") or 0)
                status = str(approval_command.get("status") or "")
                if resolved_count > 0 and status:
                    notice = format_approval_notice(status=status, resolved_count=resolved_count)
                    await notifier.send_message(text=notice, chat_id=chat_id_for_notice)
            except Exception:
                logger.warning(
                    "[WhatsApp] 审批通知发送失败 chat_id=%s",
                    chat_id_for_notice,
                    exc_info=True,
                )

    if (
        approval_command.get("resolved")
        and str(approval_command.get("status") or "") == "approved"
        and int(approval_command.get("resolved_count") or 0) > 0
    ):
        return await resume_after_approval(
            manager,
            target_instance=target_instance,
            event_payload=event_payload,
        )
    return None


def enqueue_outbound_command(*, instance_id: str, command: dict[str, Any]) -> Path:
    ts = datetime.now(UTC).strftime("%Y%m%dT%H%M%S%f")
    dest = outbox_dir_for_instance(instance_id) / f"{ts}.json"
    dest.write_text(json.dumps(command, ensure_ascii=False), encoding="utf-8")
    return dest
