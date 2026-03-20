from __future__ import annotations

import logging
from collections.abc import Mapping
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any

from src.gateway.channels.shared import format_approval_notice, query_value

if TYPE_CHECKING:
    from src.gateway.manager import GatewayManager

logger = logging.getLogger(__name__)


def _query_value(query_params: Mapping[str, str] | None, *keys: str) -> str | None:
    return query_value(query_params, *keys)


def resolve_instance_for_ingest(
    manager: GatewayManager,
    *,
    query_params: Mapping[str, str] | None,
) -> dict[str, Any] | None:
    from src.gateway.manager import GatewayManagerError

    instance_id = _query_value(query_params, "instanceId", "instance_id")
    if instance_id:
        item = manager._get_instance(instance_id)  # noqa: SLF001
        if item and str(item.get("provider")) == "discord":
            return item
        raise GatewayManagerError("gateway_instance_not_found", status_code=404)

    active_items = manager.list_provider_instances("discord", active_only=True)
    if not active_items:
        return None
    if len(active_items) == 1:
        return active_items[0]
    raise GatewayManagerError("ambiguous_discord_instance", status_code=409)


async def download_attachments(
    manager: GatewayManager,
    *,
    channel_id: str,
    message_id: Any,
    attachments: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    if not attachments:
        return []
    max_bytes = manager._discord_inbound_max_bytes()  # noqa: SLF001
    date_path = datetime.now(UTC).strftime("%Y%m%d")
    root = manager._discord_inbound_root_dir() / manager._sanitize_path_component(channel_id) / date_path  # noqa: SLF001
    root.mkdir(parents=True, exist_ok=True)

    results: list[dict[str, Any]] = []
    for idx, item in enumerate(attachments):
        file_url = str(item.get("url") or "").strip()
        if not file_url:
            continue
        expected_size = item.get("size")
        if isinstance(expected_size, int) and expected_size > max_bytes:
            results.append({**item, "status": "skipped", "reason": f"file_too_large:{expected_size}>{max_bytes}"})
            continue
        try:
            fallback_ext = manager._guess_extension(str(item.get("content_type") or ""), fallback=".bin")  # noqa: SLF001
            fallback_name = f"discord_{message_id}_{idx + 1}{fallback_ext}"
            safe_name = manager._safe_filename(str(item.get("filename") or ""), fallback=fallback_name)  # noqa: SLF001
            content = await manager._download_http_content(url=file_url, max_bytes=max_bytes)  # noqa: SLF001
            ts = datetime.now(UTC).strftime("%H%M%S")
            dest = root / f"{ts}_{idx + 1}_{safe_name}"
            dest.write_bytes(content)
            results.append({**item, "status": "downloaded", "local_path": str(dest.resolve()), "stored_size": len(content)})
        except Exception as exc:  # noqa: BLE001
            results.append({**item, "status": "error", "reason": str(exc)})
    return results


async def resume_after_approval(
    manager: GatewayManager,
    *,
    target_instance: dict[str, Any] | None,
    event_payload: dict[str, Any],
) -> dict[str, Any]:
    channel_id = str(event_payload.get("chat_id") or event_payload.get("channel_id") or "").strip()
    bot_id = str(event_payload.get("bot_id") or "").strip()
    instance_id = str(event_payload.get("instance_id") or (target_instance or {}).get("id") or "").strip()
    if not channel_id or not instance_id:
        return {"resumed": False, "reason": "missing_channel_or_instance_id"}

    gateway_key = manager.gateway_context._gateway_key(
        provider="discord",
        instance_id=instance_id,
        chat_id=channel_id,
    )  # noqa: SLF001
    conversation = await manager.gateway_context.store.aget_or_create_conversation(
        provider="discord",
        gateway_key=gateway_key,
        instance_id=instance_id,
        bot_id=bot_id,
        chat_id=channel_id,
    )
    messages = await manager.gateway_context.store.alist_context_messages(conversation["id"], limit=500)
    latest_user = next(
        (
            item
            for item in reversed(messages)
            if str(item.get("role") or "") == "user"
            and str(((item.get("metadata") if isinstance(item.get("metadata"), dict) else {}) or {}).get("source") or "")
            != "discord.gateway.resume"
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
    chat_type = str(meta.get("chat_type") or "")
    resume_payload: dict[str, Any] = {
        "instance_id": instance_id,
        "chat_id": channel_id,
        "bot_id": bot_id,
        "sender_id": meta.get("sender_id"),
        "is_mention": True,
        "is_reply_to_bot": True,
        "chat_type": chat_type,
        "attachments": attachments if isinstance(attachments, list) else [],
        "approval_scope_id": str(latest_user.get("id") or "").strip() or None,
    }

    async def _discord_result_sender(reply_text: str, ctx: dict[str, Any]) -> bool:
        notifier = manager.build_discord_notifier(target_instance)
        if not notifier:
            return False
        target_channel_id = str(ctx.get("chat_id") or "").strip() or channel_id
        return await notifier.send_notify_payload(
            {
                "content": reply_text,
                "channel_id": target_channel_id,
                "files": ctx.get("files") if isinstance(ctx, dict) else [],
            }
        )

    result = await manager.gateway_context.ingest_message(
        provider="discord",
        event_payload=resume_payload,
        source="discord.gateway.resume",
        subject=channel_id,
        text=content,
        agent_id=manager._gateway_agent_id("discord", target_instance, event_payload=resume_payload),  # noqa: SLF001
        force_execute=True,
        on_result=_discord_result_sender,
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
    channel_id_for_notice = str(event_payload.get("chat_id") or event_payload.get("channel_id") or "").strip() or None
    if channel_id_for_notice:
        notifier = manager.build_discord_notifier(target_instance)
        if notifier:
            try:
                resolved_count = int(approval_command.get("resolved_count") or 0)
                status = str(approval_command.get("status") or "")
                if resolved_count > 0 and status:
                    notice = format_approval_notice(status=status, resolved_count=resolved_count)
                    await notifier.send_message(text=notice, channel_id=channel_id_for_notice)
            except Exception:
                logger.warning(
                    "[Discord] 审批通知发送失败 channel_id=%s",
                    channel_id_for_notice,
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
