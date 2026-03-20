"""Telegram channel notifier.

Current implementation reuses the existing notifier module and serves as the
channel-local import surface for the plugin architecture.
"""

from src.gateway.notifiers.telegram_notifier import (
    SendDocumentFn,
    SendFn,
    TelegramNotifier,
    default_send_document,
    default_send_json,
)

__all__ = [
    "SendDocumentFn",
    "SendFn",
    "TelegramNotifier",
    "default_send_document",
    "default_send_json",
]
