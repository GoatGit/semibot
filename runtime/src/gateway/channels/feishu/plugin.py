from __future__ import annotations

from collections.abc import Mapping
from typing import TYPE_CHECKING, Any

from src.events.models import Event
from src.gateway.channels.base import ChannelCapabilities
from src.gateway.channels.feishu.ingress import ingest_card_actions
from src.gateway.channels.feishu.ingress import ingest_events
from src.gateway.channels.feishu.renderer import FeishuRenderer

if TYPE_CHECKING:
    from src.gateway.manager import GatewayManager


class FeishuChannelPlugin:
    provider = "feishu"

    def capabilities(self) -> ChannelCapabilities:
        return ChannelCapabilities(
            supports_text=True,
            supports_markdown=False,
            supports_file_upload=True,
            supports_file_download=False,
            supports_group_chat=True,
            supports_rich_card=True,
            supports_approval_reply=True,
            supports_mentions=True,
        )

    def build_renderer(self) -> FeishuRenderer:
        return FeishuRenderer()

    def build_notifier(self, manager: GatewayManager, instance: dict[str, Any] | None = None) -> Any:
        return manager.build_feishu_notifier(instance)

    def build_connection_supervisor(
        self,
        manager: GatewayManager,
        *,
        runtime_base_url: str,
        internal_token: str,
    ) -> Any | None:
        from src.gateway.channels.feishu.connection import FeishuLongConnectionSupervisor

        return FeishuLongConnectionSupervisor(
            gateway_manager=manager,
            runtime_base_url=runtime_base_url,
            internal_token=internal_token,
            poll_interval_seconds=5.0,
        )

    def list_active_instances(self, manager: GatewayManager) -> list[dict[str, Any]]:
        items = manager.list_provider_instances(self.provider, active_only=True)
        if not items and manager.provider_active(self.provider):
            return [{}]
        return items

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
        if not instance_id:
            return True
        return str(item.get("id") or "").strip() == instance_id

    def apply_target_overrides(self, payload: dict[str, Any], *, chat_id: str | None) -> dict[str, Any]:
        send_payload = dict(payload)
        if chat_id:
            if not str(send_payload.get("channel") or "").strip():
                send_payload["channel"] = chat_id
            if not str(send_payload.get("receive_id") or send_payload.get("receiveId") or "").strip():
                send_payload["receive_id"] = chat_id
            if not str(send_payload.get("receive_id_type") or send_payload.get("receiveIdType") or "").strip():
                send_payload["receive_id_type"] = "chat_id"
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
        notifier = self.build_notifier(manager, item)
        if not notifier:
            from src.gateway.manager import GatewayManagerError

            raise GatewayManagerError("feishu_not_configured")
        files = payload.get("files") if isinstance(payload.get("files"), list) else payload.get("attachments")
        files_list = [entry for entry in files if isinstance(entry, dict)] if isinstance(files, list) else []
        sent = await notifier.send_notify_payload(
            {
                "title": str(payload.get("title") or "Semibot Gateway Test"),
                "content": str(payload.get("content") or "Gateway connectivity test"),
                "channel": str(payload.get("channel") or "default"),
                "files": files_list,
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
        return await ingest_card_actions(
            manager,
            payload,
            query_params=query_params,
        )
