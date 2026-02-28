"""Compatibility wrapper: use gateway notifier implementation."""

from src.gateway.notifiers.telegram_notifier import SendFn, TelegramNotifier, default_send_json

__all__ = ["SendFn", "TelegramNotifier", "default_send_json"]
