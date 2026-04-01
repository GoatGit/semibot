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
from src.gateway.channels.feishu.helpers import handle_approval_followup
from src.gateway.channels.shared import ChannelAnchorAdapter, build_ingress_result
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
        approval_trace_payload: dict[str, Any] = dict(data)
        approval_trace_payload["provider"] = "feishu"
        approval_scope_ids: list[str] = []
        if event.event_type == "chat.message.received" and isinstance(event.payload, dict):
            chat_id = str(event.payload.get("chat_id") or "").strip()
            instance_id = str(event.payload.get("instance_id") or (target_instance or {}).get("id") or "").strip()
            if chat_id and instance_id:
                scope_id = manager._latest_gateway_user_scope_id(  # noqa: SLF001
                    provider="feishu",
                    instance_id=instance_id,
                    chat_id=chat_id,
                )
                if scope_id:
                    approval_scope_ids.append(scope_id)
        if approval_scope_ids:
            approval_trace_payload["approval_scope_ids"] = approval_scope_ids
        approval_command = await manager.handle_text_approval_command(
            text=text,
            source="feishu.gateway",
            subject=str(event.subject) if isinstance(event.subject, str) else None,
            trace_payload=approval_trace_payload,
        )
    gateway_result = None
    resume_result = None
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
            adapter = ChannelAnchorAdapter(manager=manager, notifier=notifier)
            return await adapter.deliver(
                {
                    "title": "Semibot",
                    "content": reply_text,
                    "channel": chat_id or "default",
                    "receive_id_type": "chat_id" if chat_id else None,
                    "receive_id": chat_id or None,
                    "files": files if isinstance(files, list) else [],
                },
                anchor_id=str(context_map.get("anchor_id") or "").strip() or None,
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
    if approval_command:
        resume_result = await handle_approval_followup(
            manager,
            target_instance=target_instance,
            event_payload=event.payload if isinstance(event.payload, dict) else {},
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
    action_idempotency_key: str | None = None
    duplicate_action = False
    if parsed["approval_id"] and parsed["decision"] in {"approved", "rejected"}:
        action_idempotency_key = manager._approval_action_idempotency_key(  # noqa: SLF001
            source="feishu.gateway",
            action=str(parsed["decision"]),
            subject=str(parsed["approval_id"]),
            trace_payload=data,
            approval_ids=[str(parsed["approval_id"])],
            execution_id=str(parsed["execution_id"] or "").strip() or None,
        )
        duplicate_action = bool(
            action_idempotency_key and manager.engine.store.exists_idempotency(action_idempotency_key)
        )
        if duplicate_action:
            duplicate_command = {
                "recognized": True,
                "resolved": True,
                "resolved_count": 0,
                "approval_ids": [str(parsed["approval_id"])],
                "status": parsed["decision"] or parsed["raw_decision"],
                "duplicate": True,
                "reason": "idempotency_hit",
                "execution_id": str(parsed["execution_id"] or "").strip() or None,
            }
            resume_result = await handle_approval_followup(
                manager,
                target_instance=target_instance,
                event_payload={
                    "chat_id": str(
                        data.get("chat_id")
                        or ((data.get("action") if isinstance(data.get("action"), dict) else {}).get("value") if isinstance((data.get("action") if isinstance(data.get("action"), dict) else {}).get("value"), dict) else {}).get("chat_id")
                        or ""
                    ).strip(),
                    "instance_id": str(target_instance.get("id") or "").strip() if isinstance(target_instance, dict) else "",
                },
                approval_command=duplicate_command,
            )
            return {
                "accepted": True,
                "approval_id": parsed["approval_id"],
                "decision": parsed["decision"] or parsed["raw_decision"],
                "resolved": True,
                "status": "duplicate",
                "duplicate": True,
                "reason": "idempotency_hit",
                "approval_action_event_id": None,
                "event_id": None,
                "matched_rules": 0,
                "resume": resume_result,
                "approval_command": duplicate_command,
            }
    approval_action_event_id: str | None = None
    if (
        parsed["approval_id"]
        and parsed["decision"] in {"approved", "rejected"}
        and not duplicate_action
    ):
        approval_command = await manager.resolve_gateway_approval_command(
            engine=manager.engine,
            target_ids=[str(parsed["approval_id"])],
            decision=str(parsed["decision"]),
            source="feishu.gateway",
            subject=str(parsed["approval_id"]),
            trace_payload={
                "trace_id": parsed["trace_id"],
                "execution_id": parsed["execution_id"],
                "anchor_id": parsed["anchor_id"],
                "raw": data,
            },
            action_idempotency_key=action_idempotency_key,
            execution_id=str(parsed["execution_id"] or "").strip() or None,
        )
        approval_action_event_id = str(approval_command.get("event_id") or "").strip() or None
    else:
        approval_command = None

    event = Event(
        event_id=f"evt_feishu_action_{uuid4().hex}",
        event_type="chat.card.action",
        source="feishu.gateway",
        subject=parsed["approval_id"],
        payload={
            "approval_id": parsed["approval_id"],
            "decision": parsed["decision"] or parsed["raw_decision"],
            "trace_id": parsed["trace_id"],
            "resolved": bool(approval_command and approval_command.get("resolved")),
            "raw": data,
        },
        risk_hint="low",
        timestamp=datetime.now(UTC),
    )
    outcomes = await manager.engine.emit(event)
    chat_id = str(
        data.get("chat_id")
        or ((data.get("action") if isinstance(data.get("action"), dict) else {}).get("value") if isinstance((data.get("action") if isinstance(data.get("action"), dict) else {}).get("value"), dict) else {}).get("chat_id")
        or ""
    ).strip()
    resume_result = None
    if approval_command:
        resume_result = await handle_approval_followup(
            manager,
            target_instance=target_instance,
            event_payload={
                "chat_id": chat_id,
                "instance_id": str(target_instance.get("id") or "").strip() if isinstance(target_instance, dict) else "",
            },
            approval_command=approval_command,
        )
    return {
        "accepted": True,
        "approval_id": parsed["approval_id"],
        "decision": parsed["decision"] or parsed["raw_decision"],
        "resolved": bool(approval_command and approval_command.get("resolved")),
        "status": approval_command.get("status") if approval_command else None,
        "approval_action_event_id": approval_action_event_id,
        "event_id": event.event_id,
        "matched_rules": len(outcomes),
        "resume": resume_result,
    }
