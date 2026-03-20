"""Common channel plugin protocol and helpers."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Protocol

from src.events.models import Event
from src.gateway.rendering.base import ChannelRenderer

if TYPE_CHECKING:
    from src.gateway.manager import GatewayManager


@dataclass(slots=True)
class ChannelCapabilities:
    supports_text: bool = True
    supports_markdown: bool = False
    supports_file_upload: bool = False
    supports_file_download: bool = False
    supports_group_chat: bool = False
    supports_threading: bool = False
    supports_rich_card: bool = False
    supports_approval_reply: bool = True
    supports_mentions: bool = True


class ChannelPlugin(Protocol):
    provider: str

    def capabilities(self) -> ChannelCapabilities: ...

    def build_renderer(self) -> ChannelRenderer | None: ...

    def build_notifier(
        self,
        manager: GatewayManager,
        instance: dict[str, Any] | None = None,
    ) -> Any: ...

    def build_connection_supervisor(
        self,
        manager: GatewayManager,
        *,
        runtime_base_url: str,
        internal_token: str,
    ) -> Any | None: ...

    def list_active_instances(self, manager: GatewayManager) -> list[dict[str, Any]]: ...

    def provider_active(self, manager: GatewayManager) -> bool: ...

    def matches_gateway_target(
        self,
        manager: GatewayManager,
        item: dict[str, Any],
        *,
        instance_id: str | None,
        chat_id: str | None,
    ) -> bool: ...

    def apply_target_overrides(
        self,
        payload: dict[str, Any],
        *,
        chat_id: str | None,
    ) -> dict[str, Any]: ...

    async def send_notify_payload(
        self,
        manager: GatewayManager,
        item: dict[str, Any] | None,
        payload: dict[str, Any],
    ) -> bool: ...

    async def handle_event(
        self,
        manager: GatewayManager,
        item: dict[str, Any] | None,
        event: Event,
    ) -> None: ...

    async def test_connection(
        self,
        manager: GatewayManager,
        item: dict[str, Any] | None,
        payload: dict[str, Any],
    ) -> dict[str, Any]: ...

    async def ingest_event(
        self,
        manager: GatewayManager,
        payload: dict[str, Any],
        *,
        headers: Mapping[str, str] | None = None,
        query_params: Mapping[str, str] | None = None,
        verify_signature: bool = True,
    ) -> dict[str, Any]: ...

    async def ingest_card_action(
        self,
        manager: GatewayManager,
        payload: dict[str, Any],
        *,
        query_params: Mapping[str, str] | None = None,
    ) -> dict[str, Any]: ...
