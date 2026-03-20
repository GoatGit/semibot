"""Feature flags for optional runtime surfaces."""

from __future__ import annotations

import os


def _parse_bool(value: str | None, default: bool) -> bool:
    if value is None:
        return default
    normalized = value.strip().lower()
    if normalized in {"1", "true", "yes", "on"}:
        return True
    if normalized in {"0", "false", "no", "off"}:
        return False
    return default


def channels_enabled() -> bool:
    return _parse_bool(os.getenv("SEMIBOT_CHANNELS_ENABLED"), True)

