"""Gateway manager wiring adapters, policies, and notifier lifecycle."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any
from uuid import uuid4

from src.events.event_engine import EventEngine
from src.events.models import Event
from src.gateway.adapters.feishu_adapter import (
    maybe_url_verification,
    normalize_message_event,
    parse_card_action,
    verify_callback_token,
)
from src.gateway.adapters.telegram_adapter import normalize_update as normalize_telegram_update
from src.gateway.adapters.telegram_adapter import (
    parse_callback_action as parse_telegram_callback_action,
)
from src.gateway.adapters.telegram_adapter import (
    verify_webhook_secret as verify_telegram_webhook_secret,
)
from src.gateway.context_service import GatewayContextService
from src.gateway.notifiers.feishu_notifier import FeishuNotifier, SendFn
from src.gateway.notifiers.telegram_notifier import SendFn as TelegramSendFn
from src.gateway.notifiers.telegram_notifier import TelegramNotifier
from src.gateway.parsers.approval_text import extract_message_text, parse_approval_text_command
from src.server.config_store import RuntimeConfigStore


class GatewayManagerError(Exception):
    def __init__(self, detail: str, *, status_code: int = 400):
        super().__init__(detail)
        self.detail = detail
        self.status_code = status_code


@dataclass(slots=True)
class GatewayManager:
    config_store: RuntimeConfigStore
    gateway_context: GatewayContextService
    engine: EventEngine
    feishu_verify_token: str | None = None
    feishu_webhook_url: str | None = None
    feishu_webhook_urls: dict[str, str] | None = None
    feishu_notify_event_types: set[str] | None = None
    feishu_templates: dict[str, dict[str, str]] | None = None
    feishu_send_fn: SendFn | None = None
    telegram_bot_token: str | None = None
    telegram_default_chat_id: str | None = None
    telegram_webhook_secret: str | None = None
    telegram_notify_event_types: set[str] | None = None
    telegram_send_fn: TelegramSendFn | None = None

    @staticmethod
    def _to_bool(value: Any, default: bool = False) -> bool:
        if isinstance(value, bool):
            return value
        if value is None:
            return default
        if isinstance(value, str):
            normalized = value.strip().lower()
            if normalized in {"1", "true", "yes", "on"}:
                return True
            if normalized in {"0", "false", "no", "off"}:
                return False
        return bool(value)

    def _get_gateway(self, provider: str) -> dict[str, Any] | None:
        try:
            return self.config_store.get_gateway_config(provider)
        except ValueError:
            return None

    def provider_config(self, provider: str) -> dict[str, Any]:
        item = self._get_gateway(provider) or {}
        config = item.get("config")
        return config if isinstance(config, dict) else {}

    def provider_active(self, provider: str) -> bool:
        item = self._get_gateway(provider)
        if item and item.get("is_active"):
            return True
        if provider == "feishu":
            return bool(self.feishu_verify_token or self.feishu_webhook_url or self.feishu_webhook_urls)
        if provider == "telegram":
            return bool(self.telegram_bot_token)
        return False

    @staticmethod
    def _telegram_bot_id(token: str | None) -> str | None:
        value = str(token or "").strip()
        if ":" not in value:
            return None
        prefix = value.split(":", 1)[0].strip()
        return prefix or None

    def build_feishu_notifier(self) -> FeishuNotifier | None:
        cfg = self.provider_config("feishu")
        webhook_url = str(cfg.get("webhookUrl") or "").strip() or self.feishu_webhook_url
        webhook_channels = cfg.get("webhookChannels")
        webhook_urls = (
            {str(k): str(v) for k, v in webhook_channels.items() if isinstance(v, str) and v}
            if isinstance(webhook_channels, dict)
            else (self.feishu_webhook_urls or {})
        )

        raw_event_types = cfg.get("notifyEventTypes")
        subscribed = self.feishu_notify_event_types
        if isinstance(raw_event_types, list):
            parsed = {str(item).strip() for item in raw_event_types if str(item).strip()}
            subscribed = parsed or None

        templates_cfg = cfg.get("templates")
        templates = templates_cfg if isinstance(templates_cfg, dict) else self.feishu_templates

        if not webhook_url and not webhook_urls:
            return None
        return FeishuNotifier(
            webhook_url=webhook_url,
            webhook_urls=webhook_urls,
            subscribed_event_types=subscribed,
            templates=templates if isinstance(templates, dict) else None,
            send_fn=self.feishu_send_fn,
        )

    def build_telegram_notifier(self) -> TelegramNotifier | None:
        cfg = self.provider_config("telegram")
        token = str(cfg.get("botToken") or "").strip() or self.telegram_bot_token
        default_chat_id = str(cfg.get("defaultChatId") or "").strip() or self.telegram_default_chat_id
        if not token:
            return None
        raw_event_types = cfg.get("notifyEventTypes")
        subscribed = self.telegram_notify_event_types
        if isinstance(raw_event_types, list):
            parsed = {str(item).strip() for item in raw_event_types if str(item).strip()}
            subscribed = parsed or None
        parse_mode_raw = cfg.get("parseMode")
        parse_mode = str(parse_mode_raw).strip() if isinstance(parse_mode_raw, str) else ""
        if parse_mode.lower() in {"none", "off", "disabled", "plain"}:
            parse_mode = ""
        disable_link_preview = self._to_bool(cfg.get("disableLinkPreview"), False)
        return TelegramNotifier(
            bot_token=token,
            default_chat_id=default_chat_id or None,
            subscribed_event_types=subscribed,
            parse_mode=parse_mode or None,
            disable_link_preview=disable_link_preview,
            send_fn=self.telegram_send_fn,
        )

    async def handle_runtime_notify_payload(self, payload: dict[str, Any]) -> None:
        feishu_notifier = self.build_feishu_notifier()
        if feishu_notifier and self.provider_active("feishu"):
            await feishu_notifier.send_notify_payload(payload)
        telegram_notifier = self.build_telegram_notifier()
        if telegram_notifier and self.provider_active("telegram"):
            await telegram_notifier.send_notify_payload(payload)

    async def handle_engine_event(self, event: Event) -> None:
        feishu_notifier = self.build_feishu_notifier()
        if feishu_notifier and self.provider_active("feishu"):
            await feishu_notifier.handle_event(event)
        telegram_notifier = self.build_telegram_notifier()
        if telegram_notifier and self.provider_active("telegram"):
            await telegram_notifier.handle_event(event)

    def _mask_gateway_config(self, provider: str, config: dict[str, Any]) -> dict[str, Any]:
        masked = dict(config)
        sensitive_fields = {
            "feishu": {"verifyToken", "encryptKey", "appSecret"},
            "telegram": {"botToken", "webhookSecret"},
        }
        for key in sensitive_fields.get(provider, set()):
            value = masked.get(key)
            if isinstance(value, str) and value:
                masked[key] = "***"
        return masked

    def _gateway_status(self, provider: str, is_active: bool, config: dict[str, Any]) -> str:
        if not is_active:
            return "disabled"
        if provider == "telegram":
            token = str(config.get("botToken") or "").strip() or str(self.telegram_bot_token or "").strip()
            return "ready" if token else "not_configured"
        if provider == "feishu":
            verify_token = str(config.get("verifyToken") or "").strip() or str(self.feishu_verify_token or "").strip()
            webhook_url = str(config.get("webhookUrl") or "").strip() or str(self.feishu_webhook_url or "").strip()
            webhook_channels = config.get("webhookChannels")
            has_channel = isinstance(webhook_channels, dict) and any(
                isinstance(v, str) and v.strip() for v in webhook_channels.values()
            )
            return "ready" if (verify_token or webhook_url or has_channel) else "not_configured"
        return "ready"

    def serialize_gateway_item(self, item: dict[str, Any]) -> dict[str, Any]:
        provider = str(item.get("provider") or "")
        config = item.get("config")
        config_map = config if isinstance(config, dict) else {}
        addressing_policy = (
            config_map.get("addressingPolicy")
            if isinstance(config_map.get("addressingPolicy"), dict)
            else None
        )
        proactive_policy = (
            config_map.get("proactivePolicy")
            if isinstance(config_map.get("proactivePolicy"), dict)
            else None
        )
        context_policy = (
            config_map.get("contextPolicy")
            if isinstance(config_map.get("contextPolicy"), dict)
            else None
        )
        is_active = bool(item.get("is_active"))
        return {
            "id": item.get("id"),
            "provider": provider,
            "displayName": item.get("display_name") or provider,
            "isActive": is_active,
            "mode": item.get("mode") or "webhook",
            "riskLevel": item.get("risk_level") or "high",
            "requiresApproval": bool(item.get("requires_approval")),
            "status": self._gateway_status(provider, is_active, config_map),
            "config": self._mask_gateway_config(provider, config_map),
            "addressingPolicy": addressing_policy,
            "proactivePolicy": proactive_policy,
            "contextPolicy": context_policy,
            "updatedAt": item.get("updated_at"),
        }

    def list_gateway_configs(self) -> list[dict[str, Any]]:
        items = self.config_store.list_gateway_configs()
        return [self.serialize_gateway_item(item) for item in items]

    def get_gateway_config(self, provider: str) -> dict[str, Any]:
        try:
            item = self.config_store.get_gateway_config(provider)
        except ValueError:
            raise GatewayManagerError("unsupported_gateway_provider") from None
        if not item:
            raise GatewayManagerError("gateway_not_found", status_code=404)
        return self.serialize_gateway_item(item)

    def upsert_gateway_config(self, provider: str, payload: dict[str, Any]) -> dict[str, Any]:
        patch: dict[str, Any] = {}
        if "displayName" in payload:
            patch["display_name"] = payload.get("displayName")
        if "display_name" in payload:
            patch["display_name"] = payload.get("display_name")
        if "isActive" in payload or "is_active" in payload:
            patch["is_active"] = self._to_bool(payload.get("isActive", payload.get("is_active")), False)
        if "mode" in payload:
            patch["mode"] = payload.get("mode")
        if "riskLevel" in payload or "risk_level" in payload:
            patch["risk_level"] = payload.get("riskLevel", payload.get("risk_level"))
        if "requiresApproval" in payload or "requires_approval" in payload:
            patch["requires_approval"] = self._to_bool(
                payload.get("requiresApproval", payload.get("requires_approval")),
                False,
            )

        merged_config: dict[str, Any] = {}
        config_payload = payload.get("config")
        if isinstance(config_payload, dict):
            merged_config.update(config_payload)
        for key in ("addressingPolicy", "proactivePolicy", "contextPolicy"):
            value = payload.get(key)
            if isinstance(value, dict):
                merged_config[key] = value
        if merged_config:
            patch["config"] = merged_config

        clear_fields = payload.get("clearFields", payload.get("clear_fields"))
        if isinstance(clear_fields, list):
            patch["clear_fields"] = [str(item) for item in clear_fields if isinstance(item, str)]

        try:
            item = self.config_store.upsert_gateway_config(provider, patch)
        except ValueError:
            raise GatewayManagerError("unsupported_gateway_provider") from None
        return self.serialize_gateway_item(item)

    async def test_gateway(self, provider: str, payload: dict[str, Any]) -> dict[str, Any]:
        if provider == "feishu":
            notifier = self.build_feishu_notifier()
            if not notifier:
                raise GatewayManagerError("feishu_not_configured")
            sent = await notifier.send_markdown(
                title=str(payload.get("title") or "Semibot Gateway Test"),
                content=str(payload.get("content") or "Gateway connectivity test"),
                channel=str(payload.get("channel") or "default"),
            )
            return {"sent": sent}
        if provider == "telegram":
            notifier = self.build_telegram_notifier()
            if not notifier:
                raise GatewayManagerError("telegram_not_configured")
            sent = await notifier.send_message(
                text=str(payload.get("text") or "Semibot Gateway Test"),
                chat_id=str(payload.get("chat_id") or payload.get("chatId") or "").strip() or None,
            )
            return {"sent": sent}
        raise GatewayManagerError("unsupported_gateway_provider")

    def list_gateway_conversations(self, *, provider: str | None = None, limit: int = 100) -> dict[str, Any]:
        items = self.gateway_context.list_conversations(provider=provider, limit=limit)
        return {
            "data": [
                {
                    "conversation_id": item["id"],
                    "provider": item["provider"],
                    "gateway_key": item["gateway_key"],
                    "main_context_id": item["main_context_id"],
                    "latest_context_version": item["latest_context_version"],
                    "status": item["status"],
                    "updated_at": item["updated_at"],
                }
                for item in items
            ]
        }

    def list_gateway_conversation_runs(self, conversation_id: str, *, limit: int = 100) -> dict[str, Any]:
        rows = self.gateway_context.list_task_runs(conversation_id, limit=limit)
        return {
            "data": [
                {
                    "run_id": row["id"],
                    "runtime_session_id": row["runtime_session_id"],
                    "snapshot_version": row["snapshot_version"],
                    "status": row["status"],
                    "result_summary": row["result_summary"],
                    "updated_at": row["updated_at"],
                }
                for row in rows
            ]
        }

    def get_gateway_conversation_context(self, conversation_id: str, *, limit: int = 200) -> dict[str, Any]:
        messages = self.gateway_context.list_context(conversation_id, limit=limit)
        return {
            "conversation_id": conversation_id,
            "messages": [
                {
                    "id": item["id"],
                    "version": item["context_version"],
                    "role": item["role"],
                    "content": item["content"],
                    "metadata": item["metadata"],
                    "created_at": item["created_at"],
                }
                for item in messages
            ],
        }

    @staticmethod
    def _approval_matches_subject(item: Any, subject: str | None) -> bool:
        if not subject:
            return False
        context = item.context if isinstance(getattr(item, "context", None), dict) else {}
        candidates = {
            str(subject),
            str(context.get("session_id") or ""),
            str(context.get("subject") or ""),
            str(context.get("chat_id") or ""),
            str(context.get("thread_id") or ""),
        }
        return str(subject) in candidates

    async def handle_text_approval_command(
        self,
        *,
        text: str,
        source: str,
        subject: str | None,
        trace_payload: dict[str, Any] | None = None,
    ) -> dict[str, Any] | None:
        parsed = parse_approval_text_command(text)
        kind = str(parsed.get("kind") or "none")
        if kind == "none":
            return None

        pending = self.engine.list_approvals(status="pending", limit=500)
        scoped_pending = [item for item in pending if self._approval_matches_subject(item, subject)]
        candidate_pool = scoped_pending or pending

        if kind == "list":
            return {
                "command": kind,
                "recognized": True,
                "resolved": False,
                "resolved_count": 0,
                "pending_count": len(candidate_pool),
                "scope": "subject" if scoped_pending else "global",
            }

        decision = "approved" if kind in {"approve", "approve_all"} else "rejected"
        target_ids: list[str] = []
        requested_id = parsed.get("approval_id")
        if isinstance(requested_id, str) and requested_id:
            target_ids = [requested_id]
        elif kind in {"approve_all", "reject_all"}:
            target_ids = [item.approval_id for item in candidate_pool]
        elif candidate_pool:
            target_ids = [candidate_pool[-1].approval_id]

        if not target_ids:
            return {
                "command": kind,
                "recognized": True,
                "resolved": False,
                "resolved_count": 0,
                "pending_count": len(candidate_pool),
                "scope": "subject" if scoped_pending else "global",
                "reason": "no_pending_approval_found",
            }

        resolved_items: list[Any] = []
        for approval_id in target_ids:
            resolved = await self.engine.resolve_approval(approval_id, decision)
            if resolved:
                resolved_items.append(resolved)

        approval_action_event = Event(
            event_id=f"evt_approval_action_{uuid4().hex}",
            event_type="approval.action",
            source=source,
            subject=subject or (target_ids[0] if target_ids else None),
            payload={
                "command": kind,
                "decision": decision,
                "approval_ids": target_ids,
                "resolved_count": len(resolved_items),
                "scope": "subject" if scoped_pending else "global",
                "text": text,
                "raw": trace_payload or {},
            },
            risk_hint="low",
            timestamp=datetime.now(UTC),
        )
        await self.engine.emit(approval_action_event)

        return {
            "command": kind,
            "recognized": True,
            "resolved": len(resolved_items) > 0,
            "resolved_count": len(resolved_items),
            "approval_ids": [item.approval_id for item in resolved_items],
            "status": decision,
            "scope": "subject" if scoped_pending else "global",
            "event_id": approval_action_event.event_id,
        }

    async def ingest_feishu_events(
        self,
        payload: dict[str, Any],
    ) -> dict[str, Any]:
        data = payload if isinstance(payload, dict) else {}
        feishu_cfg = self.provider_config("feishu")
        feishu_enabled = self.provider_active("feishu")
        verify_token = str(feishu_cfg.get("verifyToken") or "").strip() or self.feishu_verify_token
        if (
            not feishu_enabled
            and not verify_token
            and not self.feishu_webhook_url
            and not self.feishu_webhook_urls
        ):
            return {"accepted": False, "reason": "gateway_disabled"}

        challenge = maybe_url_verification(data)
        if challenge:
            if not verify_callback_token(data, verify_token):
                raise GatewayManagerError("invalid_feishu_token", status_code=401)
            return {"challenge": challenge}

        if not verify_callback_token(data, verify_token):
            raise GatewayManagerError("invalid_feishu_token", status_code=401)

        normalized = normalize_message_event(data)
        if not normalized:
            return {"accepted": False, "reason": "unsupported_feishu_event"}

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
        outcomes = await self.engine.emit(event)
        approval_command = None
        text = extract_message_text(event.payload if isinstance(event.payload, dict) else {})
        if text:
            approval_command = await self.handle_text_approval_command(
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

            async def _feishu_result_sender(reply_text: str, _context: dict[str, Any]) -> bool:
                notifier = self.build_feishu_notifier()
                if not notifier or not self.provider_active("feishu"):
                    return False
                return await notifier.send_markdown(
                    title="Semibot",
                    content=reply_text,
                    channel="default",
                )

            gateway_result = await self.gateway_context.ingest_message(
                provider="feishu",
                event_payload=event.payload,
                source=event.source,
                subject=str(event.subject) if isinstance(event.subject, str) else None,
                text=text,
                agent_id="semibot",
                force_execute=False,
                on_result=_feishu_result_sender,
            )
        return {
            "accepted": True,
            "event_id": event.event_id,
            "event_type": event.event_type,
            "matched_rules": len(outcomes),
            "approval_command": approval_command,
            "addressed": gateway_result.get("addressed") if gateway_result else None,
            "should_execute": gateway_result.get("should_execute") if gateway_result else None,
            "address_reason": gateway_result.get("address_reason") if gateway_result else None,
            "conversation_id": gateway_result.get("conversation_id") if gateway_result else None,
            "main_context_id": gateway_result.get("main_context_id") if gateway_result else None,
            "task_run_id": gateway_result.get("task_run_id") if gateway_result else None,
            "runtime_session_id": gateway_result.get("runtime_session_id") if gateway_result else None,
        }

    async def ingest_feishu_card_actions(self, payload: dict[str, Any]) -> dict[str, Any]:
        data = payload if isinstance(payload, dict) else {}
        feishu_cfg = self.provider_config("feishu")
        verify_token = str(feishu_cfg.get("verifyToken") or "").strip() or self.feishu_verify_token
        if not verify_callback_token(data, verify_token):
            raise GatewayManagerError("invalid_feishu_token", status_code=401)

        parsed = parse_card_action(data)
        approval = None
        if parsed["approval_id"] and parsed["decision"] in {"approved", "rejected"}:
            approval = await self.engine.resolve_approval(parsed["approval_id"], parsed["decision"])

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
            await self.engine.emit(approval_action_event)
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
        outcomes = await self.engine.emit(event)
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

    async def send_feishu_test(
        self,
        *,
        title: str,
        content: str,
        channel: str,
    ) -> dict[str, Any]:
        notifier = self.build_feishu_notifier()
        if not notifier:
            raise GatewayManagerError("feishu_webhook_not_configured")
        sent = await notifier.send_markdown(title=title, content=content, channel=channel)
        return {"sent": sent}

    async def ingest_telegram_webhook(
        self,
        payload: dict[str, Any],
        *,
        headers: Mapping[str, str] | None,
    ) -> dict[str, Any]:
        data = payload if isinstance(payload, dict) else {}
        tg_cfg = self.provider_config("telegram")
        tg_enabled = self.provider_active("telegram")
        token = str(tg_cfg.get("botToken") or "").strip() or str(self.telegram_bot_token or "").strip()
        if not tg_enabled and not token:
            return {"accepted": False, "reason": "gateway_disabled"}
        if tg_enabled and not token:
            return {"accepted": False, "reason": "gateway_not_configured"}

        webhook_secret = str(tg_cfg.get("webhookSecret") or "").strip() or self.telegram_webhook_secret
        if not verify_telegram_webhook_secret(headers, webhook_secret):
            raise GatewayManagerError("invalid_telegram_secret", status_code=401)

        normalized = normalize_telegram_update(
            data,
            bot_id=self._telegram_bot_id(token),
        )
        if not normalized:
            return {"accepted": False, "reason": "unsupported_telegram_event"}
        allowed_chat_ids_raw = tg_cfg.get("allowedChatIds")
        if isinstance(allowed_chat_ids_raw, list) and allowed_chat_ids_raw:
            allowed_chat_ids = {str(item) for item in allowed_chat_ids_raw if str(item).strip()}
            chat_id = normalized["payload"].get("chat_id")
            if chat_id is not None and str(chat_id) not in allowed_chat_ids:
                return {"accepted": False, "reason": "chat_not_allowed"}

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
        outcomes = await self.engine.emit(event)

        approval_command = None
        if event.event_type == "chat.card.action":
            parsed = parse_telegram_callback_action(data)
            if parsed["approval_id"] and parsed["decision"] in {"approved", "rejected"}:
                approval = await self.engine.resolve_approval(str(parsed["approval_id"]), str(parsed["decision"]))
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
                await self.engine.emit(approval_action_event)
                approval_command = {
                    "recognized": True,
                    "resolved": approval is not None,
                    "resolved_count": 1 if approval else 0,
                    "approval_ids": [parsed["approval_id"]],
                    "status": parsed["decision"],
                    "event_id": approval_action_event.event_id,
                }

        text = extract_message_text(event.payload if isinstance(event.payload, dict) else {})
        gateway_result = None
        if text and not approval_command:
            approval_command = await self.handle_text_approval_command(
                text=text,
                source="telegram.gateway",
                subject=str(event.subject) if isinstance(event.subject, str) else None,
                trace_payload=data,
            )
            if not approval_command and event.event_type == "chat.message.received" and isinstance(event.payload, dict):

                async def _telegram_result_sender(reply_text: str, ctx: dict[str, Any]) -> bool:
                    notifier = self.build_telegram_notifier()
                    if not notifier or not self.provider_active("telegram"):
                        return False
                    target_chat_id = str(ctx.get("chat_id") or "").strip() or None
                    return await notifier.send_message(text=reply_text, chat_id=target_chat_id)

                gateway_result = await self.gateway_context.ingest_message(
                    provider="telegram",
                    event_payload=event.payload,
                    source=event.source,
                    subject=str(event.subject) if isinstance(event.subject, str) else None,
                    text=text,
                    agent_id="semibot",
                    force_execute=False,
                    on_result=_telegram_result_sender,
                )

        return {
            "accepted": True,
            "event_id": event.event_id,
            "event_type": event.event_type,
            "matched_rules": len(outcomes),
            "approval_command": approval_command,
            "addressed": gateway_result.get("addressed") if gateway_result else None,
            "should_execute": gateway_result.get("should_execute") if gateway_result else None,
            "address_reason": gateway_result.get("address_reason") if gateway_result else None,
            "conversation_id": gateway_result.get("conversation_id") if gateway_result else None,
            "main_context_id": gateway_result.get("main_context_id") if gateway_result else None,
            "task_run_id": gateway_result.get("task_run_id") if gateway_result else None,
            "runtime_session_id": gateway_result.get("runtime_session_id") if gateway_result else None,
        }

    async def send_telegram_test(self, *, text: str, chat_id: str | None) -> dict[str, Any]:
        notifier = self.build_telegram_notifier()
        if not notifier:
            raise GatewayManagerError("telegram_not_configured")
        sent = await notifier.send_message(text=text, chat_id=chat_id)
        return {"sent": sent}
