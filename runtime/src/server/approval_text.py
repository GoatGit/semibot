"""Compatibility wrapper: use gateway parser implementation."""

from src.gateway.parsers.approval_text import extract_message_text, parse_approval_text_command

__all__ = ["parse_approval_text_command", "extract_message_text"]
