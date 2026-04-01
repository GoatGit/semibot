"""Lightweight text cleanup helpers for user-facing search/news snippets."""

from __future__ import annotations

import html
import re
from urllib.parse import unquote

_TAG_BLOCK_PATTERNS = (
    re.compile(r"<(script|style|svg|defs)\b[^>]*>.*?</\1>", re.IGNORECASE | re.DOTALL),
)
_INLINE_TAG_PATTERN = re.compile(r"<[^>]+>")
_URL_ENCODED_MARKER_PATTERN = re.compile(r"%(?:3[cC]|3[eE]|2[fF]|7[bB]|7[dD]|20)")
_PERCENT_BLOB_PATTERN = re.compile(r"(?:%[0-9A-Fa-f]{2}){8,}")
_LEADING_TEMPLATE_NOISE_PATTERN = re.compile(r"^\s*[\w.-]+\s*-->\s*\)?\s*", re.IGNORECASE)
_SVG_NOISE_PATTERN = re.compile(
    r"(?:class=['\"]st\d+['\"]|fill:\s*#?[0-9a-fA-F]{3,8}|points=['\"][^'\"]+['\"]|d=['\"]M[^'\"]+['\"])",
    re.IGNORECASE,
)
_WHITESPACE_PATTERN = re.compile(r"\s+")


def _maybe_url_decode(text: str) -> str:
    candidate = str(text or "").strip()
    if not candidate:
        return ""
    if not _URL_ENCODED_MARKER_PATTERN.search(candidate):
        return candidate
    decoded = unquote(candidate)
    return decoded if decoded else candidate


def clean_user_facing_snippet(text: str, *, max_chars: int = 800) -> str:
    """Remove template/SVG/style garbage from snippets before user display."""
    value = _maybe_url_decode(text)
    if not value:
        return ""
    value = html.unescape(value)
    value = _PERCENT_BLOB_PATTERN.sub(" ", value)
    for pattern in _TAG_BLOCK_PATTERNS:
        value = pattern.sub(" ", value)
    value = _INLINE_TAG_PATTERN.sub(" ", value)
    value = _SVG_NOISE_PATTERN.sub(" ", value)
    value = _LEADING_TEMPLATE_NOISE_PATTERN.sub("", value)
    value = value.replace("-->", " ").replace("<![CDATA[", " ").replace("]]>", " ")
    value = _WHITESPACE_PATTERN.sub(" ", value).strip(" \n\t-:;,.)]}")
    if not value:
        return ""
    lowered = value.lower()
    if "%3c" in lowered or "<path" in lowered or "<svg" in lowered:
        return ""
    if max_chars > 0 and len(value) > max_chars:
        return value[: max_chars - 3].rstrip() + "..."
    return value
