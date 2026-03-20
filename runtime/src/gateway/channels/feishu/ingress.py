from __future__ import annotations

from collections.abc import Mapping
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any
from uuid import uuid4

from src.events.models import Event
from src.gateway.adapters.feishu_adapter import (
    maybe_url_verification,
    normalize_message_event,
    parse_card_action,
    verify_callback_token,
)
from src.gateway.channels.feishu.helpers import resolve_instance_for_ingest
from src.gateway.channels.shared import build_ingress_result
from src.gateway.parsers.approval_text import extract_message_text

if TYPE_CHECKING:
    from src.gateway.manager import GatewayManager


async def ingest_events(
    manager: GatewayManager,
    payload: dict[str, Any],
    *,
    query_params: Mapping[str, str] | None = None,
    verify_signature: bool = True,
) -> dict[str, Any]:
    data = payload if isinstance(payload, dict) else {}
    target_instance = resolve_instance_for_ingest(manager, data, query_params)
    feishu_cfg_raw = (
        target_instance.get("config")
        if isinstance(target_instance, dict)
        else manager.provider_config("feishu")
    )
    feishu_cfg = feishu_cfg_raw if isinstance(feishu_cfg_raw, dict) else {}
    feishu_enabled = bool(target_instance.get("is_active")) if target_instance else manager.provider_active("feishu")
    verify_token = str(feishu_cfg.get("verifyToken") or "").strip() or manager.feishu_verify_token
    if not feishu_enabled and not verify_token and not manager.feishu_webhook_url and not manager.feishu_webhook_urls:
        return {"accepted": False, "reason": "gateway_disabled"}

    challenge = maybe_url_verification(data)
    if challenge:
        if verify_signature and not verify_callback_token(data, verify_token):
            from src.gateway.manager import GatewayManagerError

            raise GatewayManagerError("invalid_feishu_token", status_code=401)
        return {"challenge": challenge}

    if verify_signature and not verify_callback_token(data, verify_token):
        from src.gateway.manager import GatewayManagerError

        raise GatewayManagerError("invalid_feishu_token", status_code=401)

    normalized = normalize_message_event(
        data,
        app_id=(
            str(feishu_cfg.get("appId") or "").strip()
            or str(getattr(manager, "feishu_app_id", "") or "").strip()
            or None
        ),
    )
    if not normalized:
        return {"accepted": False, "reason": "unsupported_feishu_event"}
    if target_instance:
        payload_obj = normalized.get("payload")
        if isinstance(payload_obj, dict):
            payload_obj["instance_id"] = str(target_instance.get("id") or "").strip()
            normalized["payload"] = payload_obj

    event = Event(
        event_id=f"evt_feishu_{uuid4().hex}",
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
    text = extract_message_text(event.payload if isinstance(event.payload, dict) else {})
    if text:
        approval_command = await manager.handle_text_approval_command(
            text=text,
            source="feishu.gateway",
            subject=str(event.subject) if isinstance(event.subject, str) else None,
            trace_payload=data,
        )
    gateway_result = None
    if (
        event.event_type == "chat.message.received"
        and text
        and not approval_command
        and isinstance(event.payload, dict)
    ):

        async def _feishu_result_sender(reply_text: str, context: dict[str, Any]) -> bool:
            notifier = manager.build_feishu_notifier(target_instance)
            if not notifier:
                return False
            context_map = context if isinstance(context, dict) else {}
            files = context_map.get("files")
            chat_id = str(event.payload.get("chat_id") or "").strip()
            return await notifier.send_notify_payload(
                {
                    "title": "Semibot",
                    "content": reply_text,
                    "channel": chat_id or "default",
                    "receive_id_type": "chat_id" if chat_id else None,
                    "receive_id": chat_id or None,
                    "files": files if isinstance(files, list) else [],
                }
            )

        gateway_result = await manager.gateway_context.ingest_message(
            provider="feishu",
            event_payload=event.payload,
            source=event.source,
            subject=str(event.subject) if isinstance(event.subject, str) else None,
            text=text,
            agent_id=manager._gateway_agent_id("feishu", target_instance, event_payload=event.payload),  # noqa: SLF001
            force_execute=False,
            on_result=_feishu_result_sender,
        )
    return build_ingress_result(
        event_id=event.event_id,
        event_type=event.event_type,
        matched_rules=len(outcomes),
        approval_command=approval_command,
        gateway_result=gateway_result,
        resume_result=None,
    )


async def ingest_card_actions(
    manager: GatewayManager,
    payload: dict[str, Any],
    *,
    query_params: Mapping[str, str] | None = None,
) -> dict[str, Any]:
    data = payload if isinstance(payload, dict) else {}
    target_instance = resolve_instance_for_ingest(manager, data, query_params)
    feishu_cfg_raw = (
        target_instance.get("config")
        if isinstance(target_instance, dict)
        else manager.provider_config("feishu")
    )
    feishu_cfg = feishu_cfg_raw if isinstance(feishu_cfg_raw, dict) else {}
    verify_token = str(feishu_cfg.get("verifyToken") or "").strip() or manager.feishu_verify_token
    if not verify_callback_token(data, verify_token):
        from src.gateway.manager import GatewayManagerError

        raise GatewayManagerError("invalid_feishu_token", status_code=401)

    parsed = parse_card_action(data)
    approval = None
    if parsed["approval_id"] and parsed["decision"] in {"approved", "rejected"}:
        approval = await manager.engine.resolve_approval(parsed["approval_id"], parsed["decision"])

    approval_action_event_id: str | None = None
    if parsed["approval_id"] and parsed["decision"] in {"approved", "rejected"}:
        approval_action_event = Event(
            event_id=f"evt_approval_action_{uuid4().hex}",
            event_type="approval.action",
            source="feishu.gateway",
            subject=parsed["approval_id"],
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
        approval_action_event_id = approval_action_event.event_id

    event = Event(
        event_id=f"evt_feishu_action_{uuid4().hex}",
        event_type="chat.card.action",
        source="feishu.gateway",
        subject=parsed["approval_id"],
        payload={
            "approval_id": parsed["approval_id"],
            "decision": parsed["decision"] or parsed["raw_decision"],
            "trace_id": parsed["trace_id"],
            "resolved": approval is not None,
            "raw": data,
        },
        risk_hint="low",
        timestamp=datetime.now(UTC),
    )
    outcomes = await manager.engine.emit(event)
    return {
        "accepted": True,
        "approval_id": parsed["approval_id"],
        "decision": parsed["decision"] or parsed["raw_decision"],
        "resolved": approval is not None,
        "status": approval.status if approval else None,
        "approval_action_event_id": approval_action_event_id,
        "event_id": event.event_id,
        "matched_rules": len(outcomes),
    }
