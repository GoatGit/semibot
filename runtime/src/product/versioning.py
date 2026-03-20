from __future__ import annotations

import json
import re
from typing import Any
from urllib.request import Request, urlopen


_DATE_VERSION_RE = re.compile(r"^\d{4}\.\d{2}\.\d{2}\.\d{2}$")


def _parse_release_version(value: str | None) -> list[int] | None:
    raw = str(value or "").strip()
    if not _DATE_VERSION_RE.match(raw):
        return None
    return [int(part) for part in raw.split(".")]


def compare_release_versions(left: str | None, right: str | None) -> int:
    left_parsed = _parse_release_version(left)
    right_parsed = _parse_release_version(right)
    if not left_parsed or not right_parsed:
        return str(left or "").strip().casefold().__lt__(str(right or "").strip().casefold()) and -1 or (
            str(left or "").strip().casefold().__gt__(str(right or "").strip().casefold()) and 1 or 0
        )
    for index in range(max(len(left_parsed), len(right_parsed))):
        delta = (left_parsed[index] if index < len(left_parsed) else 0) - (
            right_parsed[index] if index < len(right_parsed) else 0
        )
        if delta != 0:
            return delta
    return 0


def resolve_update_payload(*, manifest_url: str | None, current_version: str | None) -> dict[str, Any]:
    normalized_url = str(manifest_url or "").strip() or None
    normalized_current = str(current_version or "").strip() or None
    base_payload = {
        "current_version": normalized_current,
        "manifest_url": normalized_url,
        "latest_version": None,
        "update_available": False,
        "release_url": None,
        "release_notes_url": None,
        "channel": None,
        "checked_at": None,
        "upgrade_command": f"semibot upgrade --manifest-url {normalized_url}" if normalized_url else None,
        "error": None,
    }
    if not normalized_url:
        return base_payload

    request = Request(normalized_url, headers={"User-Agent": "semibot-runtime-version-check/1"})
    try:
        with urlopen(request, timeout=3.0) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except Exception as exc:
        return {
            **base_payload,
            "checked_at": __import__("datetime").datetime.now(__import__("datetime").UTC).isoformat(),
            "error": str(exc),
        }

    latest_version = str(payload.get("version") or "").strip() or None
    return {
        **base_payload,
        "latest_version": latest_version,
        "update_available": bool(
            normalized_current and latest_version and compare_release_versions(latest_version, normalized_current) > 0
        ),
        "release_url": str(payload.get("archive_url") or "").strip() or None,
        "release_notes_url": str(payload.get("release_notes_url") or "").strip() or None,
        "channel": str(payload.get("channel") or "").strip() or None,
        "checked_at": __import__("datetime").datetime.now(__import__("datetime").UTC).isoformat(),
    }
