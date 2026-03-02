#!/usr/bin/env python3
"""End-to-end smoke test for Telegram attachment -> Semibot gateway flow.

Usage example:
  runtime/.venv/bin/python runtime/scripts/telegram_attachment_e2e.py \
    --bot-token "$TG_BOT_TOKEN" \
    --chat-id "-1001234567890" \
    --runtime-url "http://127.0.0.1:8765"
"""

from __future__ import annotations

import argparse
import json
import os
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import httpx


@dataclass
class CheckResult:
    ok: bool
    message: str
    details: dict[str, Any]


def _now_ts() -> float:
    return time.time()


def _create_temp_csv() -> Path:
    fd, path = tempfile.mkstemp(prefix="semibot_tg_attach_", suffix=".csv")
    os.close(fd)
    p = Path(path)
    p.write_text("region,sales\nNorth,120\nSouth,95\n", encoding="utf-8")
    return p


def _telegram_send_document(*, bot_token: str, chat_id: str, file_path: Path, caption: str) -> dict[str, Any]:
    url = f"https://api.telegram.org/bot{bot_token}/sendDocument"
    with file_path.open("rb") as fp:
        files = {"document": (file_path.name, fp, "text/csv")}
        data = {"chat_id": chat_id, "caption": caption}
        resp = httpx.post(url, data=data, files=files, timeout=30.0)
    resp.raise_for_status()
    payload = resp.json()
    if not isinstance(payload, dict) or payload.get("ok") is not True:
        raise RuntimeError(f"sendDocument failed: {payload}")
    return payload


def _runtime_get(runtime_url: str, path: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
    url = runtime_url.rstrip("/") + path
    resp = httpx.get(url, params=params, timeout=15.0)
    resp.raise_for_status()
    payload = resp.json()
    if not isinstance(payload, dict):
        raise RuntimeError(f"invalid runtime response: {payload}")
    return payload


def _runtime_post(
    runtime_url: str,
    path: str,
    *,
    payload: dict[str, Any],
    params: dict[str, Any] | None = None,
    headers: dict[str, str] | None = None,
) -> dict[str, Any]:
    url = runtime_url.rstrip("/") + path
    resp = httpx.post(url, params=params, json=payload, headers=headers or {}, timeout=20.0)
    resp.raise_for_status()
    data = resp.json()
    if not isinstance(data, dict):
        raise RuntimeError(f"invalid runtime response: {data}")
    return data


def _to_chat_id_value(chat_id: str) -> str | int:
    text = str(chat_id).strip()
    if text and text.lstrip("-").isdigit():
        try:
            return int(text)
        except Exception:
            return text
    return text


def _extract_document_file_id(send_payload: dict[str, Any] | None) -> str:
    if not isinstance(send_payload, dict):
        return ""
    result = send_payload.get("result")
    if not isinstance(result, dict):
        return ""
    doc = result.get("document")
    if not isinstance(doc, dict):
        return ""
    return str(doc.get("file_id") or "").strip()


def _inject_runtime_webhook(
    *,
    runtime_url: str,
    chat_id: str,
    file_id: str,
    caption: str,
    instance_id: str | None,
    webhook_secret: str | None,
) -> dict[str, Any]:
    params: dict[str, Any] = {}
    if instance_id:
        params["instance_id"] = instance_id
    headers: dict[str, str] = {}
    if webhook_secret:
        headers["x-telegram-bot-api-secret-token"] = webhook_secret
    caption_entities: list[dict[str, Any]] = []
    caption_text = str(caption or "").strip()
    if caption_text.startswith("@"):
        mention_token = caption_text.split(" ", 1)[0]
        caption_entities.append({"offset": 0, "length": len(mention_token), "type": "mention"})

    payload = {
        "update_id": int(time.time() * 1000),
        "message": {
            "message_id": int(time.time() * 1000) % 100000000,
            "chat": {"id": _to_chat_id_value(chat_id), "type": "group"},
            "from": {"id": 10000001, "is_bot": False, "first_name": "E2E"},
            "caption": caption,
            "caption_entities": caption_entities,
            "document": {
                "file_id": file_id,
                "file_name": "e2e.csv",
                "mime_type": "text/csv",
            },
        },
    }
    return _runtime_post(
        runtime_url,
        "/v1/integrations/telegram/webhook",
        payload=payload,
        params=params or None,
        headers=headers or None,
    )


def _find_conversation(*, runtime_url: str, gateway_key: str) -> str | None:
    data = _runtime_get(runtime_url, "/v1/gateway/conversations", {"provider": "telegram", "limit": 100})
    rows = data.get("data")
    if not isinstance(rows, list):
        return None
    for item in rows:
        if not isinstance(item, dict):
            continue
        if str(item.get("gateway_key") or "") == gateway_key:
            cid = str(item.get("conversation_id") or "").strip()
            if cid:
                return cid
    return None


def _find_attachment_message(*, runtime_url: str, conversation_id: str) -> tuple[dict[str, Any], dict[str, Any]] | None:
    payload = _runtime_get(
        runtime_url,
        f"/v1/gateway/conversations/{conversation_id}/context",
        {"limit": 200},
    )
    rows = payload.get("messages")
    if not isinstance(rows, list):
        return None
    for item in reversed(rows):
        if not isinstance(item, dict):
            continue
        if str(item.get("role") or "") != "user":
            continue
        metadata = item.get("metadata")
        if not isinstance(metadata, dict):
            continue
        attachments = metadata.get("attachments")
        if isinstance(attachments, list) and attachments:
            return item, metadata
    return None


def _latest_run(*, runtime_url: str, conversation_id: str) -> dict[str, Any] | None:
    payload = _runtime_get(
        runtime_url,
        f"/v1/gateway/conversations/{conversation_id}/runs",
        {"limit": 20},
    )
    rows = payload.get("data")
    if not isinstance(rows, list) or not rows:
        return None
    first = rows[0]
    return first if isinstance(first, dict) else None


def run_check(
    *,
    runtime_url: str,
    bot_token: str,
    chat_id: str,
    file_path: Path,
    caption: str,
    timeout_sec: int,
    poll_interval_sec: float,
    skip_send: bool,
    inject_webhook: bool,
    instance_id: str | None,
    webhook_secret: str | None,
) -> CheckResult:
    bot_id = bot_token.split(":", 1)[0].strip()
    if not bot_id:
        return CheckResult(False, "invalid bot token", {})

    gateway_key = f"telegram:{bot_id}:{chat_id}"
    start_at = _now_ts()
    send_payload: dict[str, Any] | None = None
    inject_payload: dict[str, Any] | None = None

    if not skip_send:
        send_payload = _telegram_send_document(
            bot_token=bot_token,
            chat_id=chat_id,
            file_path=file_path,
            caption=caption,
        )
        if inject_webhook:
            file_id = _extract_document_file_id(send_payload)
            if not file_id:
                return CheckResult(
                    False,
                    "sendDocument ok but no document.file_id in response",
                    {"send_payload": send_payload},
                )
            try:
                inject_payload = _inject_runtime_webhook(
                    runtime_url=runtime_url,
                    chat_id=chat_id,
                    file_id=file_id,
                    caption=caption,
                    instance_id=instance_id,
                    webhook_secret=webhook_secret,
                )
            except Exception as exc:
                return CheckResult(
                    False,
                    f"runtime webhook injection failed: {exc}",
                    {"send_payload": send_payload},
                )
            if inject_payload.get("accepted") is False:
                return CheckResult(
                    False,
                    "runtime webhook injection not accepted",
                    {
                        "send_payload": send_payload,
                        "inject_payload": inject_payload,
                    },
                )

    deadline = start_at + timeout_sec
    conversation_id: str | None = None
    attachment_message: dict[str, Any] | None = None
    attachment_meta: dict[str, Any] | None = None
    latest_run: dict[str, Any] | None = None

    while _now_ts() < deadline:
        conversation_id = _find_conversation(runtime_url=runtime_url, gateway_key=gateway_key)
        if conversation_id:
            found = _find_attachment_message(runtime_url=runtime_url, conversation_id=conversation_id)
            if found:
                attachment_message, attachment_meta = found
                latest_run = _latest_run(runtime_url=runtime_url, conversation_id=conversation_id)
                break
        time.sleep(poll_interval_sec)

    if not conversation_id:
        return CheckResult(
            False,
            "conversation not found in gateway context",
            {
                "gateway_key": gateway_key,
                "send_payload": send_payload,
                "inject_payload": inject_payload,
            },
        )

    if not attachment_message or not attachment_meta:
        return CheckResult(
            False,
            "attachment metadata not found in conversation context",
            {
                "conversation_id": conversation_id,
                "gateway_key": gateway_key,
                "send_payload": send_payload,
                "inject_payload": inject_payload,
            },
        )

    if isinstance(inject_payload, dict):
        should_execute = inject_payload.get("should_execute")
        if should_execute is False:
            return CheckResult(
                False,
                "webhook accepted but should_execute=false (check addressing policy or mention)",
                {
                    "conversation_id": conversation_id,
                    "inject_payload": inject_payload,
                    "send_payload": send_payload,
                },
            )

    attachments = attachment_meta.get("attachments")
    if not isinstance(attachments, list) or not attachments:
        return CheckResult(
            False,
            "attachments list is empty",
            {
                "conversation_id": conversation_id,
                "message": attachment_message,
            },
        )

    first = attachments[0] if isinstance(attachments[0], dict) else {}
    local_path = str(first.get("local_path") or "").strip()
    exists = Path(local_path).exists() if local_path else False
    if not local_path or not exists:
        return CheckResult(
            False,
            "attachment downloaded path missing or file not found",
            {
                "conversation_id": conversation_id,
                "attachment": first,
                "run": latest_run,
            },
        )

    return CheckResult(
        True,
        "telegram attachment flow ok",
        {
            "gateway_key": gateway_key,
            "conversation_id": conversation_id,
            "attachment_path": local_path,
            "attachment_name": first.get("file_name"),
            "attachment_size": first.get("stored_size"),
            "run": latest_run,
            "send_payload": send_payload,
            "inject_payload": inject_payload,
        },
    )


def main() -> int:
    parser = argparse.ArgumentParser(description="Telegram attachment E2E check")
    parser.add_argument("--runtime-url", default="http://127.0.0.1:8765")
    parser.add_argument("--bot-token", required=True)
    parser.add_argument("--chat-id", required=True)
    parser.add_argument("--file", default=None, help="Path to file to upload (defaults to temp csv)")
    parser.add_argument(
        "--caption",
        default="@semibot 请读取附件并做一个简要总结",
        help="Telegram caption text sent with file",
    )
    parser.add_argument("--timeout-sec", type=int, default=45)
    parser.add_argument("--poll-interval-sec", type=float, default=1.5)
    parser.add_argument("--skip-send", action="store_true", help="Only validate latest already-sent attachment flow")
    parser.add_argument(
        "--no-inject-webhook",
        action="store_true",
        help="Disable synthetic inbound webhook injection after sendDocument",
    )
    parser.add_argument("--instance-id", default=None, help="Optional gateway instance id for webhook injection")
    parser.add_argument(
        "--webhook-secret",
        default=None,
        help="Optional telegram webhook secret, sent as x-telegram-bot-api-secret-token",
    )
    parser.add_argument("--json", action="store_true", help="Output JSON only")
    args = parser.parse_args()

    file_path = Path(args.file).expanduser().resolve() if args.file else _create_temp_csv()
    if not file_path.is_file():
        print(f"ERROR: file not found: {file_path}")
        return 2

    try:
        result = run_check(
            runtime_url=args.runtime_url,
            bot_token=args.bot_token,
            chat_id=args.chat_id,
            file_path=file_path,
            caption=args.caption,
            timeout_sec=args.timeout_sec,
            poll_interval_sec=args.poll_interval_sec,
            skip_send=args.skip_send,
            inject_webhook=not bool(args.no_inject_webhook),
            instance_id=args.instance_id,
            webhook_secret=args.webhook_secret,
        )
    finally:
        # only remove temp file auto-created by script
        if not args.file:
            try:
                file_path.unlink(missing_ok=True)
            except Exception:
                pass

    payload = {"ok": result.ok, "message": result.message, "details": result.details}
    if args.json:
        print(json.dumps(payload, ensure_ascii=False, indent=2))
    else:
        status = "OK" if result.ok else "FAIL"
        print(f"[{status}] {result.message}")
        print(json.dumps(result.details, ensure_ascii=False, indent=2))
    return 0 if result.ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
