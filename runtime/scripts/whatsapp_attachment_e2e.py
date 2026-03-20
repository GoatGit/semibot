#!/usr/bin/env python3
"""Live WhatsApp attachment E2E helper.

Flow:
1. Upsert a WhatsApp channel instance.
2. Ask the operator to upload a real file in the target chat with a token.
3. Poll gateway context until the attachment is observed with local_path metadata.
"""

from __future__ import annotations

import argparse
import json
import secrets
import sys
import time
from dataclasses import dataclass
from typing import Any

import httpx


@dataclass
class CheckResult:
    ok: bool
    message: str
    details: dict[str, Any]


def _runtime_get(runtime_url: str, path: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
    resp = httpx.get(runtime_url.rstrip("/") + path, params=params, timeout=20.0)
    resp.raise_for_status()
    payload = resp.json()
    if not isinstance(payload, dict):
        raise RuntimeError(f"invalid runtime response: {payload}")
    return payload


def _runtime_post(runtime_url: str, path: str, payload: dict[str, Any]) -> dict[str, Any]:
    resp = httpx.post(runtime_url.rstrip("/") + path, json=payload, timeout=30.0)
    resp.raise_for_status()
    data = resp.json()
    if not isinstance(data, dict):
        raise RuntimeError(f"invalid runtime response: {data}")
    return data


def _runtime_put(runtime_url: str, path: str, payload: dict[str, Any]) -> dict[str, Any]:
    resp = httpx.put(runtime_url.rstrip("/") + path, json=payload, timeout=30.0)
    resp.raise_for_status()
    data = resp.json()
    if not isinstance(data, dict):
        raise RuntimeError(f"invalid runtime response: {data}")
    return data


def _find_instance(runtime_url: str, *, provider: str, instance_key: str) -> dict[str, Any] | None:
    data = _runtime_get(runtime_url, "/v1/config/gateway-instances", {"provider": provider})
    rows = data.get("data") if isinstance(data.get("data"), list) else []
    for item in rows:
        if not isinstance(item, dict):
            continue
        if str(item.get("instance_key") or item.get("instanceKey") or "").strip() == instance_key:
            return item
    return None


def _upsert_whatsapp_instance(
    runtime_url: str,
    *,
    instance_key: str,
    display_name: str,
    session_name: str,
    chat_id: str,
    linked_phone: str | None,
) -> dict[str, Any]:
    existing = _find_instance(runtime_url, provider="whatsapp", instance_key=instance_key)
    payload = {
        "provider": "whatsapp",
        "instanceKey": instance_key,
        "displayName": display_name,
        "isActive": True,
        "mode": "gateway",
        "config": {
            "sessionName": session_name,
            "linkedPhone": linked_phone or "",
        },
    }
    if existing:
        instance_id = str(existing.get("id") or "").strip()
        if not instance_id:
            raise RuntimeError("existing whatsapp instance missing id")
        return _runtime_put(runtime_url, f"/v1/config/gateway-instances/{instance_id}", payload)
    return _runtime_post(runtime_url, "/v1/config/gateway-instances", payload)


def _send_setup_message(runtime_url: str, *, instance_id: str, token: str) -> dict[str, Any]:
    prompt = (
        "Semibot WhatsApp 附件 E2E 已启动。\n"
        "请在当前 WhatsApp 会话上传一个真实文件，并在同一条消息里带上下面这串 token：\n"
        f"{token}\n"
        "建议同时补一句“请读取附件并总结”。脚本会检查附件是否被桥接下载到本地。"
    )
    return _runtime_post(runtime_url, f"/v1/config/gateway-instances/{instance_id}/test", {"text": prompt})


def _find_conversation(runtime_url: str, *, gateway_key: str) -> str | None:
    payload = _runtime_get(runtime_url, "/v1/gateway/conversations", {"provider": "whatsapp", "limit": 100})
    rows = payload.get("data") if isinstance(payload.get("data"), list) else []
    for item in rows:
        if not isinstance(item, dict):
            continue
        if str(item.get("gateway_key") or "").strip() == gateway_key:
            conversation_id = str(item.get("conversation_id") or "").strip()
            if conversation_id:
                return conversation_id
    return None


def _get_context(runtime_url: str, conversation_id: str) -> list[dict[str, Any]]:
    payload = _runtime_get(runtime_url, f"/v1/gateway/conversations/{conversation_id}/context", {"limit": 200})
    rows = payload.get("messages")
    return rows if isinstance(rows, list) else []


def _get_runs(runtime_url: str, conversation_id: str) -> list[dict[str, Any]]:
    payload = _runtime_get(runtime_url, f"/v1/gateway/conversations/{conversation_id}/runs", {"limit": 20})
    rows = payload.get("data")
    return rows if isinstance(rows, list) else []


def run_check(
    *,
    runtime_url: str,
    session_name: str,
    chat_id: str,
    linked_phone: str | None,
    instance_key: str,
    display_name: str,
    timeout_sec: int,
    poll_interval_sec: float,
) -> CheckResult:
    instance = _upsert_whatsapp_instance(
        runtime_url,
        instance_key=instance_key,
        display_name=display_name,
        session_name=session_name,
        chat_id=chat_id,
        linked_phone=linked_phone,
    )
    instance_id = str(instance.get("id") or "").strip()
    if not instance_id:
        return CheckResult(False, "whatsapp instance upsert failed", {"instance": instance})

    token = f"semibot-whatsapp-attachment-{secrets.token_hex(4)}"
    send_result = _send_setup_message(runtime_url, instance_id=instance_id, token=token)
    if send_result.get("sent") is not True:
        return CheckResult(False, "setup message send failed", {"instance_id": instance_id, "send_result": send_result})

    gateway_key = f"whatsapp:{session_name}:{chat_id}"
    deadline = time.time() + timeout_sec
    conversation_id: str | None = None
    matched_message: dict[str, Any] | None = None
    matched_attachment: dict[str, Any] | None = None
    matched_run: dict[str, Any] | None = None

    while time.time() < deadline:
        conversation_id = _find_conversation(runtime_url, gateway_key=gateway_key)
        if conversation_id:
            messages = _get_context(runtime_url, conversation_id)
            for item in reversed(messages):
                if not isinstance(item, dict):
                    continue
                if str(item.get("role") or "") != "user":
                    continue
                content = str(item.get("content") or "")
                metadata = item.get("metadata") if isinstance(item.get("metadata"), dict) else {}
                attachments = metadata.get("attachments") if isinstance(metadata.get("attachments"), list) else []
                downloaded = [a for a in attachments if isinstance(a, dict) and str(a.get("local_path") or "").strip()]
                if token in content and downloaded:
                    matched_message = item
                    matched_attachment = downloaded[0]
                    break
            if matched_message:
                runs = _get_runs(runtime_url, conversation_id)
                matched_run = runs[0] if runs and isinstance(runs[0], dict) else None
                break
        time.sleep(poll_interval_sec)

    if not conversation_id:
        return CheckResult(
            False,
            "conversation not found; confirm whatsapp bridge is running and instance is linked",
            {"instance_id": instance_id, "gateway_key": gateway_key, "token": token},
        )
    if not matched_message or not matched_attachment:
        return CheckResult(
            False,
            "no downloaded attachment observed; upload a real file and include the printed token",
            {"conversation_id": conversation_id, "gateway_key": gateway_key, "token": token},
        )

    return CheckResult(
        True,
        "whatsapp attachment E2E observed downloaded attachment",
        {
            "instance_id": instance_id,
            "gateway_key": gateway_key,
            "conversation_id": conversation_id,
            "token": token,
            "send_result": send_result,
            "user_message": matched_message,
            "attachment": matched_attachment,
            "run": matched_run,
        },
    )


def main() -> int:
    parser = argparse.ArgumentParser(description="WhatsApp attachment live E2E helper")
    parser.add_argument("--runtime-url", default="http://127.0.0.1:8765")
    parser.add_argument("--session-name", required=True)
    parser.add_argument("--chat-id", required=True)
    parser.add_argument("--linked-phone", default=None)
    parser.add_argument("--instance-key", default="whatsapp-attachment-e2e")
    parser.add_argument("--display-name", default="WhatsApp Attachment E2E")
    parser.add_argument("--timeout-sec", type=int, default=180)
    parser.add_argument("--poll-interval-sec", type=float, default=2.0)
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()

    try:
        result = run_check(
            runtime_url=args.runtime_url,
            session_name=args.session_name,
            chat_id=args.chat_id,
            linked_phone=args.linked_phone,
            instance_key=args.instance_key,
            display_name=args.display_name,
            timeout_sec=args.timeout_sec,
            poll_interval_sec=args.poll_interval_sec,
        )
    except Exception as exc:  # noqa: BLE001
        payload = {"ok": False, "message": str(exc), "details": {}}
        print(json.dumps(payload, ensure_ascii=False, indent=2))
        return 1

    payload = {"ok": result.ok, "message": result.message, "details": result.details}
    if args.json:
        print(json.dumps(payload, ensure_ascii=False, indent=2))
    else:
        status = "OK" if result.ok else "FAIL"
        print(f"[{status}] {result.message}")
        print(json.dumps(result.details, ensure_ascii=False, indent=2))
    return 0 if result.ok else 1


if __name__ == "__main__":
    sys.exit(main())
