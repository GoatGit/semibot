"""Registry for channel plugins."""

from __future__ import annotations

from dataclasses import dataclass, field

from src.gateway.channels.base import ChannelPlugin


@dataclass(slots=True)
class ChannelPluginRegistry:
    _plugins: dict[str, ChannelPlugin] = field(default_factory=dict)

    def register(self, plugin: ChannelPlugin) -> None:
        self._plugins[plugin.provider] = plugin

    def get(self, provider: str) -> ChannelPlugin | None:
        return self._plugins.get(str(provider or "").strip().lower())

    def providers(self) -> list[str]:
        return sorted(self._plugins.keys())
