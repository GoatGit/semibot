"""Gateway text command parsing for approval actions."""

from __future__ import annotations

import re
from typing import Any

_APPROVAL_ID_RE = re.compile(r"\b(appr_[A-Za-z0-9]+)\b", re.IGNORECASE)

_APPROVE_TOKENS = (
    "同意",
    "确认",
    "批准",
    "通过",
    "approve",
    "approved",
    "yes",
    "ok",
)
_REJECT_TOKENS = (
    "拒绝",
    "驳回",
    "否决",
    "不同意",
    "reject",
    "rejected",
    "deny",
    "denied",
    "no",
)
_LIST_TOKENS = (
    "审批列表",
    "待审批",
    "approvals",
    "approval list",
)
_ALL_TOKENS = ("全部", "所有", "all")


def _contains_any(text: str, tokens: tuple[str, ...]) -> bool:
    return any(token in text for token in tokens)


def _normalize_text(raw: str) -> str:
    lowered = raw.strip().lower()
    return " ".join(lowered.split())


def parse_approval_text_command(raw_text: str) -> dict[str, str | None]:
    """
    Parse free-form text command for approval actions.

    Returns:
      kind: none|list|approve|reject|approve_all|reject_all
      approval_id: optional approval id in text
      raw_text: normalized input
    """
    text = _normalize_text(raw_text)
    if not text:
        return {"kind": "none", "approval_id": None, "raw_text": text}

    approval_id: str | None = None
    match = _APPROVAL_ID_RE.search(text)
    if match:
        approval_id = match.group(1)

    if _contains_any(text, _LIST_TOKENS):
        return {"kind": "list", "approval_id": approval_id, "raw_text": text}

    has_reject = _contains_any(text, _REJECT_TOKENS)
    has_approve = _contains_any(text, _APPROVE_TOKENS)
    has_all = _contains_any(text, _ALL_TOKENS)

    if has_reject and has_all:
        return {"kind": "reject_all", "approval_id": approval_id, "raw_text": text}
    if has_approve and has_all:
        return {"kind": "approve_all", "approval_id": approval_id, "raw_text": text}
    if has_reject:
        return {"kind": "reject", "approval_id": approval_id, "raw_text": text}
    if has_approve:
        return {"kind": "approve", "approval_id": approval_id, "raw_text": text}
    return {"kind": "none", "approval_id": approval_id, "raw_text": text}


def extract_message_text(payload: dict[str, Any]) -> str:
    """Extract best-effort plain text from normalized chat payload."""
    content = payload.get("content")
    if isinstance(content, dict):
        for key in ("text", "raw", "content", "message"):
            value = content.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()
    for key in ("text", "message", "raw"):
        value = payload.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return ""
