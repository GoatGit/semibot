from __future__ import annotations

from collections.abc import Mapping
from typing import TYPE_CHECKING, Any

from src.events.models import Event
from src.gateway.channels.base import ChannelCapabilities
from src.gateway.channels.imessage.ingress import ingest_events
from src.gateway.channels.imessage.notifier import IMessageNotifier
from src.gateway.channels.imessage.renderer import IMessageRenderer

if TYPE_CHECKING:
    from src.gateway.manager import GatewayManager


class IMessageChannelPlugin:
    provider = "imessage"

    def capabilities(self) -> ChannelCapabilities:
        return ChannelCapabilities(
            supports_text=True,
            supports_markdown=False,
            supports_file_upload=True,
            supports_file_download=True,
            supports_group_chat=True,
            supports_threading=False,
            supports_rich_card=False,
            supports_approval_reply=True,
            supports_mentions=False,
        )

    def build_renderer(self) -> IMessageRenderer:
        return IMessageRenderer()

    def build_notifier(self, manager: GatewayManager, instance: dict[str, Any] | None = None) -> Any:
        cfg = instance.get("config") if isinstance(instance, dict) else manager.provider_config(self.provider)
        cfg = cfg if isinstance(cfg, dict) else {}
        raw_event_types = cfg.get("notifyEventTypes")
        subscribed = None
        if isinstance(raw_event_types, list):
            parsed = {str(item).strip() for item in raw_event_types if str(item).strip()}
            subscribed = parsed or None
        return IMessageNotifier(
            bridge_url=str(cfg.get("bridgeUrl") or "").strip() or None,
            default_handle=str(cfg.get("defaultHandle") or "").strip() or None,
            subscribed_event_types=subscribed,
            send_fn=getattr(manager, "imessage_send_fn", None),
        )

    def build_connection_supervisor(
        self,
        manager: GatewayManager,
        *,
        runtime_base_url: str,
        internal_token: str,
    ) -> Any | None:
        from src.gateway.channels.imessage.connection import IMessageConnectionSupervisor

        return IMessageConnectionSupervisor(
            gateway_manager=manager,
            runtime_base_url=runtime_base_url,
            internal_token=internal_token,
            poll_interval_seconds=5.0,
        )

    def list_active_instances(self, manager: GatewayManager) -> list[dict[str, Any]]:
        return manager.list_provider_instances(self.provider, active_only=True)

    def provider_active(self, manager: GatewayManager) -> bool:
        return manager.provider_active(self.provider)

    def matches_gateway_target(
        self,
        manager: GatewayManager,
        item: dict[str, Any],
        *,
        instance_id: str | None,
        chat_id: str | None,
    ) -> bool:
        if instance_id and str(item.get("id") or "").strip() != instance_id:
            return False
        return True

    def apply_target_overrides(self, payload: dict[str, Any], *, chat_id: str | None) -> dict[str, Any]:
        send_payload = dict(payload)
        if chat_id and not str(send_payload.get("chat_id") or send_payload.get("chatId") or "").strip():
            send_payload["chat_id"] = chat_id
        return send_payload

    async def send_notify_payload(
        self,
        manager: GatewayManager,
        item: dict[str, Any] | None,
        payload: dict[str, Any],
    ) -> bool:
        notifier = self.build_notifier(manager, item)
        if not notifier:
            return False
        return await notifier.send_notify_payload(payload)

    async def handle_event(
        self,
        manager: GatewayManager,
        item: dict[str, Any] | None,
        event: Event,
    ) -> None:
        notifier = self.build_notifier(manager, item)
        if notifier:
            await notifier.handle_event(event)

    async def test_connection(
        self,
        manager: GatewayManager,
        item: dict[str, Any] | None,
        payload: dict[str, Any],
    ) -> dict[str, Any]:
        from src.gateway.manager import GatewayManagerError

        notifier = self.build_notifier(manager, item)
        if not notifier:
            raise GatewayManagerError("imessage_not_configured", status_code=501)
        target_handle = str(payload.get("chat_id") or payload.get("chatId") or payload.get("handle") or "").strip()
        if not notifier.bridge_url or not (target_handle or notifier.default_handle):
            raise GatewayManagerError("imessage_not_configured", status_code=501)
        sent = await notifier.send_notify_payload(
            {
                "text": str(payload.get("text") or payload.get("content") or "Semibot iMessage 测试消息"),
                "chat_id": target_handle or None,
            }
        )
        return {"sent": sent}

    async def ingest_event(
        self,
        manager: GatewayManager,
        payload: dict[str, Any],
        *,
        headers: Mapping[str, str] | None = None,
        query_params: Mapping[str, str] | None = None,
        verify_signature: bool = True,
    ) -> dict[str, Any]:
        return await ingest_events(
            manager,
            payload,
            headers=headers,
            query_params=query_params,
            verify_signature=verify_signature,
        )

    async def ingest_card_action(
        self,
        manager: GatewayManager,
        payload: dict[str, Any],
        *,
        query_params: Mapping[str, str] | None = None,
    ) -> dict[str, Any]:
        from src.gateway.manager import GatewayManagerError

        raise GatewayManagerError("unsupported_gateway_card_action")
