"""Compatibility wrapper: use gateway adapter implementation."""

from src.gateway.adapters.telegram_adapter import parse_callback_action, normalize_update, verify_webhook_secret

__all__ = ["verify_webhook_secret", "normalize_update", "parse_callback_action"]
