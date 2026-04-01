"""Compatibility wrapper for Discord notifier implementation."""

from src.gateway.channels.discord.notifier import DiscordNotifier, SendFn, default_send_discord

__all__ = ["DiscordNotifier", "SendFn", "default_send_discord"]
