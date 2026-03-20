from __future__ import annotations

import hmac
from collections.abc import Mapping
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any
from uuid import uuid4

from src.events.models import Event
from src.gateway.channels.discord.helpers import (
    download_attachments,
    handle_approval_followup,
    resolve_instance_for_ingest,
)
from src.gateway.channels.shared import build_ingress_result
from src.gateway.parsers.approval_text import extract_message_text

if TYPE_CHECKING:
    from src.gateway.manager import GatewayManager


def _verify_webhook_secret(headers: Mapping[str, str] | None, expected_secret: str | None) -> bool:
    if not expected_secret:
        return True
    if not headers:
        return False
    token = headers.get("x-webhook-secret") or headers.get("X-Webhook-Secret")
    return isinstance(token, str) and hmac.compare_digest(token, expected_secret)


async def ingest_events(
    manager: GatewayManager,
    payload: dict[str, Any],
    *,
    headers: Mapping[str, str] | None = None,
    query_params: Mapping[str, str] | None = None,
    verify_signature: bool = True,
) -> dict[str, Any]:
    from src.gateway.manager import GatewayManagerError

    data = payload if isinstance(payload, dict) else {}
    target_instance = resolve_instance_for_ingest(manager, query_params=query_params)
    discord_cfg_raw = (
        target_instance.get("config") if isinstance(target_instance, dict) else manager.provider_config("discord")
    )
    discord_cfg = discord_cfg_raw if isinstance(discord_cfg_raw, dict) else {}

    if verify_signature:
        webhook_secret = str(discord_cfg.get("webhookSecret") or "").strip() or None
        if not _verify_webhook_secret(headers, webhook_secret):
            raise GatewayManagerError("invalid_discord_webhook_secret", status_code=401)
    discord_enabled = bool(target_instance.get("is_active")) if target_instance else manager.provider_active("discord")
    bot_token = str(discord_cfg.get("botToken") or "").strip()
    if not discord_enabled and not bot_token:
        return {"accepted": False, "reason": "gateway_disabled"}
    if discord_enabled and not bot_token:
        return {"accepted": False, "reason": "gateway_not_configured"}

    event_type = str(data.get("type") or "").strip().lower()
    raw = data.get("data")
    message = raw if isinstance(raw, dict) else {}
    if event_type != "message_create" or not message:
        return {"accepted": False, "reason": "unsupported_discord_event"}

    author = message.get("author")
    author_map = author if isinstance(author, dict) else {}
    if bool(author_map.get("bot")):
        return {"accepted": False, "reason": "bot_message_ignored"}

    channel_id = str(message.get("channel_id") or "").strip()
    guild_id = str(message.get("guild_id") or "").strip()
    bot_user_id = str(data.get("bot_user_id") or discord_cfg.get("botUserId") or "").strip()
    content = str(message.get("content") or "").strip()
    mentions_raw = message.get("mentions")
    mentions = [item for item in mentions_raw if isinstance(item, dict)] if isinstance(mentions_raw, list) else []
    is_mention = bool(bot_user_id and any(str(item.get("id") or "").strip() == bot_user_id for item in mentions))
    chat_type = "dm" if not guild_id else "guild"

    attachments_raw = message.get("attachments")
    attachments = [item for item in attachments_raw if isinstance(item, dict)] if isinstance(attachments_raw, list) else []
    if attachments:
        attachments = await download_attachments(
            manager,
            channel_id=channel_id,
            message_id=message.get("id"),
            attachments=attachments,
        )
    if not content and attachments:
        content = f"用户上传了 {len(attachments)} 个文件，请先读取附件并完成用户请求。"

    normalized_payload = {
        "instance_id": str((target_instance or {}).get("id") or "").strip() or None,
        "chat_id": channel_id,
        "channel_id": channel_id,
        "guild_id": guild_id or None,
        "bot_id": bot_user_id or None,
        "sender_id": str(author_map.get("id") or "").strip() or None,
        "sender_name": str(author_map.get("username") or "").strip() or None,
        "chat_type": chat_type,
        "is_mention": is_mention,
        "is_reply_to_bot": False,
        "content": {"text": content, "attachments": attachments},
        "attachments": attachments,
        "message_id": str(message.get("id") or "").strip() or None,
    }
    event = Event(
        event_id=f"evt_discord_{uuid4().hex}",
        event_type="chat.message.received",
        source="discord.gateway",
        subject=channel_id or None,
        payload=normalized_payload,
        idempotency_key=str(message.get("id") or uuid4().hex),
        risk_hint="low",
        timestamp=datetime.now(UTC),
    )
    if event.idempotency_key and manager.engine.store.exists_idempotency(event.idempotency_key):
        return {"accepted": True, "reason": "idempotency_hit", "event_id": event.event_id}

    outcomes = await manager.engine.emit(event)

    text = extract_message_text(normalized_payload)
    approval_scope_ids: list[str] = []
    instance_id = str(normalized_payload.get("instance_id") or "").strip()
    if channel_id and instance_id:
        scope_id = manager._latest_gateway_user_scope_id(  # noqa: SLF001
            provider="discord",
            instance_id=instance_id,
            chat_id=channel_id,
        )
        if scope_id:
            approval_scope_ids.append(scope_id)
    trace_payload: dict[str, Any] = dict(data)
    if approval_scope_ids:
        trace_payload["approval_scope_ids"] = approval_scope_ids
    approval_command = (
        await manager.handle_text_approval_command(
            text=text,
            source="discord.gateway",
            subject=str(event.subject) if isinstance(event.subject, str) else None,
            trace_payload=trace_payload,
        )
        if text
        else None
    )

    gateway_result = None
    if (text or attachments) and not approval_command:

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

        gateway_result = await manager.gateway_context.ingest_message(
            provider="discord",
            event_payload=normalized_payload,
            source=event.source,
            subject=str(event.subject) if isinstance(event.subject, str) else None,
            text=text,
            agent_id=manager._gateway_agent_id("discord", target_instance, event_payload=normalized_payload),  # noqa: SLF001
            force_execute=False,
            on_result=_discord_result_sender,
        )

    resume_result = None
    if approval_command:
        resume_result = await handle_approval_followup(
            manager,
            target_instance=target_instance,
            event_payload=normalized_payload,
            approval_command=approval_command,
        )

    return build_ingress_result(
        event_id=event.event_id,
        event_type=event.event_type,
        matched_rules=len(outcomes),
        approval_command=approval_command,
        gateway_result=gateway_result,
        resume_result=resume_result,
    )
