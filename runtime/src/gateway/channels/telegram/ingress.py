from __future__ import annotations

from collections.abc import Mapping
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any
from uuid import uuid4

from src.events.models import Event
from src.gateway.adapters.telegram_adapter import normalize_update as normalize_telegram_update
from src.gateway.adapters.telegram_adapter import (
    parse_callback_action as parse_telegram_callback_action,
)
from src.gateway.adapters.telegram_adapter import (
    verify_webhook_secret as verify_telegram_webhook_secret,
)
from src.gateway.channels.shared import build_ingress_result
from src.gateway.channels.telegram.helpers import (
    download_attachments,
    handle_approval_followup,
    resolve_instance_for_ingest,
)
from src.gateway.parsers.approval_text import extract_message_text

if TYPE_CHECKING:
    from src.gateway.manager import GatewayManager


async def ingest_webhook(
    manager: GatewayManager,
    payload: dict[str, Any],
    *,
    headers: Mapping[str, str] | None,
    query_params: Mapping[str, str] | None = None,
) -> dict[str, Any]:
    data = payload if isinstance(payload, dict) else {}
    target_instance = resolve_instance_for_ingest(manager, headers=headers, query_params=query_params)
    tg_cfg_raw = (
        target_instance.get("config")
        if isinstance(target_instance, dict)
        else manager.provider_config("telegram")
    )
    tg_cfg = tg_cfg_raw if isinstance(tg_cfg_raw, dict) else {}
    tg_enabled = bool(target_instance.get("is_active")) if target_instance else manager.provider_active("telegram")
    token = str(tg_cfg.get("botToken") or "").strip() or str(manager.telegram_bot_token or "").strip()
    if not tg_enabled and not token:
        return {"accepted": False, "reason": "gateway_disabled"}
    if tg_enabled and not token:
        return {"accepted": False, "reason": "gateway_not_configured"}

    webhook_secret = str(tg_cfg.get("webhookSecret") or "").strip() or manager.telegram_webhook_secret
    if not verify_telegram_webhook_secret(headers, webhook_secret):
        from src.gateway.manager import GatewayManagerError

        raise GatewayManagerError("invalid_telegram_secret", status_code=401)

    normalized = normalize_telegram_update(
        data,
        bot_id=manager._telegram_bot_id(token),  # noqa: SLF001
    )
    if not normalized:
        return {"accepted": False, "reason": "unsupported_telegram_event"}

    payload_obj = normalized.get("payload")
    normalized_payload = payload_obj if isinstance(payload_obj, dict) else {}
    if target_instance and str(target_instance.get("id") or "").strip():
        normalized_payload["instance_id"] = str(target_instance.get("id") or "").strip()
    if normalized.get("event_type") == "chat.message.received":
        raw_attachments = normalized_payload.get("attachments")
        attachments = [item for item in raw_attachments if isinstance(item, dict)] if isinstance(raw_attachments, list) else []
        if attachments:
            downloaded = await download_attachments(
                manager,
                token=token,
                chat_id=str(normalized_payload.get("chat_id") or ""),
                message_id=normalized_payload.get("message_id"),
                attachments=attachments,
            )
            normalized_payload["attachments"] = downloaded
            content = normalized_payload.get("content")
            if isinstance(content, dict):
                content["attachments"] = downloaded
            normalized["payload"] = normalized_payload

    event = Event(
        event_id=f"evt_tg_{uuid4().hex}",
        event_type=normalized["event_type"],
        source=normalized["source"],
        subject=normalized["subject"],
        payload=normalized["payload"],
        idempotency_key=normalized["idempotency_key"],
        risk_hint="low",
        timestamp=datetime.now(UTC),
    )
    if event.idempotency_key and manager.engine.store.exists_idempotency(event.idempotency_key):
        return {"accepted": True, "reason": "idempotency_hit", "event_id": event.event_id}

    outcomes = await manager.engine.emit(event)

    approval_command = None
    if event.event_type == "chat.card.action":
        parsed = parse_telegram_callback_action(data)
        if parsed["approval_id"] and parsed["decision"] in {"approved", "rejected"}:
            approval = await manager.engine.resolve_approval(str(parsed["approval_id"]), str(parsed["decision"]))
            approval_action_event = Event(
                event_id=f"evt_approval_action_{uuid4().hex}",
                event_type="approval.action",
                source="telegram.gateway",
                subject=str(parsed["approval_id"]),
                payload={
                    "approval_id": parsed["approval_id"],
                    "decision": parsed["decision"],
                    "trace_id": parsed["trace_id"],
                    "resolved": approval is not None,
                    "raw": data,
                },
                risk_hint="low",
                timestamp=datetime.now(UTC),
            )
            await manager.engine.emit(approval_action_event)
            approval_command = {
                "recognized": True,
                "resolved": approval is not None,
                "resolved_count": 1 if approval else 0,
                "approval_ids": [parsed["approval_id"]],
                "status": parsed["decision"],
                "event_id": approval_action_event.event_id,
            }

    payload_map = event.payload if isinstance(event.payload, dict) else {}
    text = extract_message_text(payload_map)
    attachments_raw = payload_map.get("attachments")
    downloaded_attachments = [
        item for item in attachments_raw if isinstance(item, dict) and str(item.get("local_path") or "").strip()
    ] if isinstance(attachments_raw, list) else []
    if not text and downloaded_attachments:
        text = f"用户上传了 {len(downloaded_attachments)} 个文件，请先读取附件并完成用户请求。"
    gateway_result = None
    resume_result = None
    if (text or downloaded_attachments) and not approval_command:
        approval_scope_ids: list[str] = []
        if event.event_type == "chat.message.received":
            chat_id = str(payload_map.get("chat_id") or "").strip()
            instance_id = str(payload_map.get("instance_id") or (target_instance or {}).get("id") or "").strip()
            if chat_id and instance_id:
                scope_id = manager._latest_gateway_user_scope_id(  # noqa: SLF001
                    provider="telegram",
                    instance_id=instance_id,
                    chat_id=chat_id,
                )
                if scope_id:
                    approval_scope_ids.append(scope_id)

        trace_payload: dict[str, Any] = dict(data)
        if approval_scope_ids:
            trace_payload["approval_scope_ids"] = approval_scope_ids
        approval_command = await manager.handle_text_approval_command(
            text=text,
            source="telegram.gateway",
            subject=str(event.subject) if isinstance(event.subject, str) else None,
            trace_payload=trace_payload,
        )
        if not approval_command and event.event_type == "chat.message.received" and isinstance(event.payload, dict):

            async def _telegram_result_sender(reply_text: str, ctx: dict[str, Any]) -> bool:
                notifier = manager.build_telegram_notifier(target_instance)
                if not notifier:
                    return False
                target_chat_id = str(ctx.get("chat_id") or "").strip() or None
                return await notifier.send_notify_payload(
                    {
                        "content": reply_text,
                        "chat_id": target_chat_id,
                        "files": ctx.get("files") if isinstance(ctx, dict) else [],
                    }
                )

            gateway_result = await manager.gateway_context.ingest_message(
                provider="telegram",
                event_payload=event.payload,
                source=event.source,
                subject=str(event.subject) if isinstance(event.subject, str) else None,
                text=text,
                agent_id=manager._gateway_agent_id("telegram", target_instance, event_payload=event.payload),  # noqa: SLF001
                force_execute=False,
                on_result=_telegram_result_sender,
            )
    if approval_command and event.event_type in {"chat.message.received", "chat.card.action"}:
        resume_result = await handle_approval_followup(
            manager,
            target_instance=target_instance,
            token=token,
            event_payload=payload_map,
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
