"""Addressing policy (should execute or keep as context-only)."""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(slots=True)
class AddressingDecision:
    addressed: bool
    should_execute: bool
    reason: str


def has_command_prefix(text: str, prefixes: list[str]) -> bool:
    normalized = (text or "").strip().lower()
    for item in prefixes:
        prefix = str(item or "").strip().lower()
        if prefix and normalized.startswith(prefix):
            return True
    return False


def decide_addressing(
    *,
    text: str,
    is_mention: bool,
    is_reply_to_bot: bool,
    policy: dict,
    continuation_hit: bool = False,
) -> AddressingDecision:
    mode = str(policy.get("mode") or "all_messages").strip().lower()
    allow_reply = bool(policy.get("allowReplyToBot", True))
    prefixes = policy.get("commandPrefixes")
    command_prefixes = prefixes if isinstance(prefixes, list) else ["/ask", "/run", "/approve", "/reject"]

    if not (text or "").strip():
        return AddressingDecision(addressed=False, should_execute=False, reason="empty_text")

    if is_mention:
        return AddressingDecision(addressed=True, should_execute=True, reason="mention")

    if allow_reply and is_reply_to_bot:
        return AddressingDecision(addressed=True, should_execute=True, reason="reply_to_bot")

    if has_command_prefix(text, [str(item) for item in command_prefixes]):
        return AddressingDecision(addressed=True, should_execute=True, reason="command_prefix")

    if mode == "mention_only":
        return AddressingDecision(addressed=False, should_execute=False, reason="mention_required")

    if continuation_hit:
        return AddressingDecision(addressed=True, should_execute=True, reason="continuation_window")

    execute_on_unaddressed = bool(policy.get("executeOnUnaddressed", False))
    if execute_on_unaddressed:
        return AddressingDecision(addressed=True, should_execute=True, reason="all_messages_unaddressed_allowed")

    return AddressingDecision(addressed=False, should_execute=False, reason="not_addressed")
