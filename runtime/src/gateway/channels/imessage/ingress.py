from __future__ import annotations

import hmac
from collections.abc import Mapping
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any
from uuid import uuid4

from src.events.models import Event
from src.gateway.channels.imessage.helpers import resolve_instance_for_ingest
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

    target_instance = resolve_instance_for_ingest(manager, query_params=query_params)
    cfg_raw = target_instance.get("config") if isinstance(target_instance, dict) else manager.provider_config("imessage")
    cfg = cfg_raw if isinstance(cfg_raw, dict) else {}

    if verify_signature:
        webhook_secret = str(cfg.get("webhookSecret") or "").strip() or None
        if not _verify_webhook_secret(headers, webhook_secret):
            raise GatewayManagerError("invalid_imessage_webhook_secret", status_code=401)
    bridge_url = str(cfg.get("bridgeUrl") or "").strip()
    default_handle = str(cfg.get("defaultHandle") or "").strip()
    if not target_instance and not manager.provider_active("imessage"):
        return {"accepted": False, "reason": "gateway_disabled"}
    if not bridge_url and not default_handle:
        raise GatewayManagerError("imessage_not_configured", status_code=501)

    data = payload if isinstance(payload, dict) else {}
    event_type = str(data.get("type") or "").strip().lower()
    raw = data.get("data")
    message = raw if isinstance(raw, dict) else {}
    if event_type not in {"message", "message_received"} or not message:
        raise GatewayManagerError("imessage_ingress_not_implemented", status_code=501)

    chat_id = str(message.get("chat_id") or message.get("handle") or message.get("chatId") or "").strip()
    if not chat_id:
        return {"accepted": False, "reason": "missing_chat_id"}
    text = str(message.get("text") or "").strip()
    attachments_raw = message.get("attachments")
    attachments = [item for item in attachments_raw if isinstance(item, dict)] if isinstance(attachments_raw, list) else []
    normalized_payload = {
        "chat_id": chat_id,
        "instance_id": str((target_instance or {}).get("id") or "").strip() or None,
        "bot_id": str(data.get("bot_id") or cfg.get("bridgeBotId") or "imessage").strip() or None,
        "sender_id": str(message.get("sender_id") or chat_id).strip() or None,
        "sender_name": str(message.get("sender_name") or "").strip() or None,
        "chat_type": str(message.get("chat_type") or "dm").strip().lower() or "dm",
        "is_mention": False,
        "is_reply_to_bot": False,
        "content": {"text": text, "attachments": attachments},
        "attachments": attachments,
        "message_id": str(message.get("id") or "").strip() or None,
    }
    event = Event(
        event_id=f"evt_imessage_{uuid4().hex}",
        event_type="chat.message.received",
        source="imessage.gateway",
        subject=chat_id,
        payload=normalized_payload,
        idempotency_key=str(message.get("id") or uuid4().hex),
        risk_hint="low",
        timestamp=datetime.now(UTC),
    )
    if event.idempotency_key and manager.engine.store.exists_idempotency(event.idempotency_key):
        return {"accepted": True, "reason": "idempotency_hit", "event_id": event.event_id}

    outcomes = await manager.engine.emit(event)

    approval_command = None
    gateway_result = None
    resume_result = None
    extracted_text = extract_message_text(normalized_payload)
    if extracted_text or attachments:
        trace_payload: dict[str, Any] = dict(data)
        approval_command = await manager.handle_text_approval_command(
            text=extracted_text,
            source="imessage.gateway",
            subject=chat_id,
            trace_payload=trace_payload,
        )
        if not approval_command:

            async def _imessage_result_sender(reply_text: str, ctx: dict[str, Any]) -> bool:
                notifier = manager.build_imessage_notifier(target_instance)
                if not notifier:
                    return False
                target_handle = str(ctx.get("chat_id") or "").strip() or chat_id
                return await notifier.send_notify_payload(
                    {
                        "content": reply_text,
                        "chat_id": target_handle,
                        "files": ctx.get("files") if isinstance(ctx, dict) else [],
                    }
                )

            gateway_result = await manager.gateway_context.ingest_message(
                provider="imessage",
                event_payload=normalized_payload,
                source=event.source,
                subject=chat_id,
                text=extracted_text,
                agent_id=manager._gateway_agent_id("imessage", target_instance, event_payload=normalized_payload),  # noqa: SLF001
                force_execute=False,
                on_result=_imessage_result_sender,
            )

    if approval_command and approval_command.get("resolved") and str(approval_command.get("status") or "") == "approved":
        resume_result = {"resumed": True, "status": "approved"}

    return build_ingress_result(
        event_id=event.event_id,
        event_type=event.event_type,
        matched_rules=len(outcomes),
        approval_command=approval_command,
        gateway_result=gateway_result,
        resume_result=resume_result,
    )
