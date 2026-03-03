#!/usr/bin/env python3
"""Smoke test: send outbound files to gateway (telegram/feishu) via runtime API."""

from __future__ import annotations

import argparse
import json
import sys
import tempfile
from pathlib import Path
from urllib import request


def _http_json(method: str, url: str, payload: dict | None = None) -> dict:
    data = None
    headers = {"Content-Type": "application/json"}
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
    req = request.Request(url=url, method=method, headers=headers, data=data)
    with request.urlopen(req, timeout=20) as resp:  # noqa: S310
        body = resp.read().decode("utf-8")
        return json.loads(body) if body else {}


def _create_demo_files() -> tuple[Path, Path]:
    tmp = Path(tempfile.mkdtemp(prefix="semibot-gw-files-"))
    pdf_path = tmp / "gateway-test.pdf"
    xlsx_path = tmp / "gateway-test.xlsx"
    # Minimal payloads for transport test only.
    pdf_path.write_bytes(b"%PDF-1.4\n% semibot gateway outbound file test\n")
    xlsx_path.write_bytes(b"PK\x03\x04semibot-xlsx-test")
    return pdf_path, xlsx_path


def main() -> int:
    parser = argparse.ArgumentParser(description="Test outbound file delivery via gateway test API")
    parser.add_argument("--runtime-url", default="http://127.0.0.1:8765", help="Runtime base URL")
    parser.add_argument("--provider", default="telegram", choices=["telegram", "feishu"], help="Gateway provider")
    parser.add_argument("--instance-id", default="", help="Optional gateway instance id")
    args = parser.parse_args()

    base = args.runtime_url.rstrip("/")
    pdf_path, xlsx_path = _create_demo_files()

    instance_id = args.instance_id.strip()
    if not instance_id:
        listing = _http_json("GET", f"{base}/v1/config/gateway-instances?provider={args.provider}")
        rows = (
            listing.get("items")
            if isinstance(listing.get("items"), list)
            else listing.get("data")
            if isinstance(listing.get("data"), list)
            else []
        )
        active = [item for item in rows if isinstance(item, dict) and bool(item.get("isActive"))]
        if len(active) != 1:
            print(
                json.dumps(
                    {
                        "ok": False,
                        "reason": "need_exactly_one_active_instance_or_pass_instance_id",
                        "provider": args.provider,
                        "active_count": len(active),
                    },
                    ensure_ascii=False,
                    indent=2,
                )
            )
            return 2
        instance_id = str(active[0].get("id") or "").strip()

    payload = {
        "text": "Semibot gateway outbound file smoke test",
        "content": "Semibot gateway outbound file smoke test",
        "instanceId": instance_id,
        "files": [
            {"local_path": str(pdf_path), "filename": pdf_path.name, "mime_type": "application/pdf"},
            {
                "local_path": str(xlsx_path),
                "filename": xlsx_path.name,
                "mime_type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            },
        ],
    }

    result = _http_json("POST", f"{base}/v1/config/gateway-instances/{instance_id}/test", payload)
    ok = bool(result.get("sent"))
    print(
        json.dumps(
            {
                "ok": ok,
                "provider": args.provider,
                "instance_id": instance_id,
                "runtime_result": result,
                "files": [str(pdf_path), str(xlsx_path)],
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
