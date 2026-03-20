"""Compatibility wrapper: use gateway adapter implementation."""

from src.gateway.adapters.feishu_adapter import maybe_url_verification, normalize_message_event, parse_card_action, verify_callback_token

__all__ = ["verify_callback_token", "maybe_url_verification", "normalize_message_event", "parse_card_action"]
