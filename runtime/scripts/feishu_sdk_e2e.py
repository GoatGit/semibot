#!/usr/bin/env python3
"""Feishu SDK channel e2e smoke test.

Flow:
1) read feishu channel instances from runtime config API
2) pick target instance(s)
3) call /v1/config/gateway-instances/{id}/test
"""

from __future__ import annotations

import argparse
import json
from datetime import UTC, datetime
from typing import Any

import httpx


def _now_text() -> str:
    return datetime.now(UTC).strftime("%Y-%m-%d %H:%M:%SZ")


def _pick_targets(
    items: list[dict[str, Any]], instance_id: str | None, *, allow_disabled: bool
) -> list[dict[str, Any]]:
    if instance_id:
        return [item for item in items if str(item.get("id")) == instance_id]
    active = [item for item in items if bool(item.get("isActive"))]
    if active:
        return active
    return items if allow_disabled else []


def main() -> int:
    parser = argparse.ArgumentParser(description="Feishu SDK channel e2e smoke test")
    parser.add_argument("--base-url", default="http://127.0.0.1:8765", help="runtime base url")
    parser.add_argument("--instance-id", default="", help="specific channel instance id")
    parser.add_argument("--title", default="Semibot Feishu SDK E2E", help="test title")
    parser.add_argument(
        "--content",
        default=f"Feishu SDK test message at {_now_text()}",
        help="test content",
    )
    parser.add_argument("--channel", default="default", help="notify channel")
    parser.add_argument(
        "--allow-disabled",
        action="store_true",
        help="allow disabled instances when no active instance exists",
    )
    args = parser.parse_args()

    base = args.base_url.rstrip("/")
    target_instance = args.instance_id.strip() or None
    out: dict[str, Any] = {
        "base_url": base,
        "instance_id": target_instance,
        "title": args.title,
        "content": args.content,
        "channel": args.channel,
    }

    with httpx.Client(timeout=20.0) as client:
        list_resp = client.get(f"{base}/v1/config/gateway-instances", params={"provider": "feishu"})
        list_resp.raise_for_status()
        payload = list_resp.json()
        items = payload.get("data") if isinstance(payload, dict) else None
        if not isinstance(items, list):
            raise RuntimeError("invalid gateway-instances response")
        out["instances_total"] = len(items)
        targets = _pick_targets(items, target_instance, allow_disabled=bool(args.allow_disabled))
        out["targets"] = [
            {
                "id": item.get("id"),
                "displayName": item.get("displayName"),
                "isActive": item.get("isActive"),
                "status": item.get("status"),
            }
            for item in targets
        ]
        if not targets:
            out["ok"] = False
            out["error"] = "no_target_instance (no active feishu channel; use --allow-disabled to force)"
            print(json.dumps(out, ensure_ascii=False, indent=2))
            return 1

        results: list[dict[str, Any]] = []
        for item in targets:
            inst_id = str(item.get("id") or "").strip()
            if not inst_id:
                continue
            resp = client.post(
                f"{base}/v1/config/gateway-instances/{inst_id}/test",
                json={
                    "title": args.title,
                    "content": args.content,
                    "channel": args.channel,
                },
            )
            result_entry: dict[str, Any] = {
                "instance_id": inst_id,
                "http_status": resp.status_code,
            }
            try:
                result_entry["response"] = resp.json()
            except Exception:  # noqa: BLE001
                result_entry["response"] = {"raw": resp.text}
            results.append(result_entry)

        out["results"] = results
        out["ok"] = all(
            entry.get("http_status") == 200 and bool((entry.get("response") or {}).get("sent"))
            for entry in results
        )

    print(json.dumps(out, ensure_ascii=False, indent=2))
    return 0 if out["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
