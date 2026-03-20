#!/usr/bin/env python3
"""Live WhatsApp approval E2E helper.

Flow:
1. Upsert a WhatsApp channel instance.
2. Ask the operator to send a real high-risk prompt in WhatsApp.
3. Poll runtime until pending approval is created.
4. Ask the operator to reply “同意”.
5. Poll until approval is resolved and assistant follow-up arrives.
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


def _send_setup_message(runtime_url: str, *, instance_id: str, prompt: str, token: str) -> dict[str, Any]:
    text = (
        "Semibot WhatsApp 审批 E2E 已启动。\n"
        "请在当前 WhatsApp 会话发送下面这条真实消息，用来触发高风险审批：\n\n"
        f"{prompt} [{token}]\n\n"
        "脚本会先等待审批创建，再等待你回复“同意”。"
    )
    return _runtime_post(runtime_url, f"/v1/config/gateway-instances/{instance_id}/test", {"text": text})


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


def _list_approvals(runtime_url: str, status: str | None = None) -> list[dict[str, Any]]:
    params = {"limit": 200}
    if status:
        params["status"] = status
    payload = _runtime_get(runtime_url, "/v1/approvals", params)
    rows = payload.get("items")
    return rows if isinstance(rows, list) else []


def run_check(
    *,
    runtime_url: str,
    session_name: str,
    chat_id: str,
    linked_phone: str | None,
    instance_key: str,
    display_name: str,
    prompt: str,
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

    token = f"semibot-whatsapp-approval-{secrets.token_hex(4)}"
    send_result = _send_setup_message(runtime_url, instance_id=instance_id, prompt=prompt, token=token)
    if send_result.get("sent") is not True:
        return CheckResult(False, "setup message send failed", {"instance_id": instance_id, "send_result": send_result})

    gateway_key = f"whatsapp:{session_name}:{chat_id}"
    deadline = time.time() + timeout_sec
    conversation_id: str | None = None
    user_message: dict[str, Any] | None = None
    approval_row: dict[str, Any] | None = None
    approval_resolved: dict[str, Any] | None = None
    assistant_message: dict[str, Any] | None = None

    phase = "wait_user_prompt"
    while time.time() < deadline:
        conversation_id = _find_conversation(runtime_url, gateway_key=gateway_key)
        if conversation_id:
            messages = _get_context(runtime_url, conversation_id)
            if phase == "wait_user_prompt":
                for item in reversed(messages):
                    if not isinstance(item, dict):
                        continue
                    if str(item.get("role") or "") == "user" and token in str(item.get("content") or ""):
                        user_message = item
                        phase = "wait_approval"
                        break
            if phase == "wait_approval" and user_message:
                scope_id = str(user_message.get("id") or "").strip()
                for item in _list_approvals(runtime_url, "pending"):
                    if not isinstance(item, dict):
                        continue
                    ctx = item.get("context") if isinstance(item.get("context"), dict) else {}
                    if str(ctx.get("approval_scope_id") or "").strip() == scope_id:
                        approval_row = item
                        phase = "wait_approval_resolution"
                        break
            if phase == "wait_approval_resolution" and approval_row:
                approval_id = str(approval_row.get("approval_id") or "").strip()
                for item in _list_approvals(runtime_url):
                    if not isinstance(item, dict):
                        continue
                    if str(item.get("approval_id") or "").strip() != approval_id:
                        continue
                    if str(item.get("status") or "").strip() == "approved":
                        approval_resolved = item
                        phase = "wait_assistant_followup"
                        break
            if phase == "wait_assistant_followup" and approval_resolved:
                for item in reversed(messages):
                    if not isinstance(item, dict):
                        continue
                    if str(item.get("role") or "") != "assistant":
                        continue
                    content = str(item.get("content") or "")
                    if "已通过" in content or "done:" in content or "继续执行" in content:
                        assistant_message = item
                        break
                if assistant_message:
                    break
        time.sleep(poll_interval_sec)

    if not conversation_id:
        return CheckResult(
            False,
            "conversation not found; confirm whatsapp bridge is running and instance is linked",
            {"instance_id": instance_id, "gateway_key": gateway_key, "token": token},
        )
    if not user_message:
        return CheckResult(
            False,
            "no live approval prompt observed; send the instructed prompt in WhatsApp",
            {"conversation_id": conversation_id, "token": token, "prompt": prompt},
        )
    if not approval_row:
        return CheckResult(
            False,
            "approval was not created; the prompt may not have triggered a high-risk tool",
            {"conversation_id": conversation_id, "token": token, "prompt": prompt, "user_message": user_message},
        )
    if not approval_resolved:
        return CheckResult(
            False,
            "approval is still pending; reply “同意” in WhatsApp and rerun or wait longer",
            {"conversation_id": conversation_id, "approval": approval_row},
        )
    if not assistant_message:
        return CheckResult(
            False,
            "approval resolved but no assistant follow-up observed yet",
            {"conversation_id": conversation_id, "approval": approval_resolved},
        )

    return CheckResult(
        True,
        "whatsapp approval E2E observed pending -> approved -> resume flow",
        {
            "instance_id": instance_id,
            "gateway_key": gateway_key,
            "conversation_id": conversation_id,
            "token": token,
            "prompt": prompt,
            "send_result": send_result,
            "user_message": user_message,
            "approval": approval_resolved,
            "assistant_message": assistant_message,
        },
    )


def main() -> int:
    parser = argparse.ArgumentParser(description="WhatsApp approval live E2E helper")
    parser.add_argument("--runtime-url", default="http://127.0.0.1:8765")
    parser.add_argument("--session-name", required=True)
    parser.add_argument("--chat-id", required=True)
    parser.add_argument("--linked-phone", default=None)
    parser.add_argument("--instance-key", default="whatsapp-approval-e2e")
    parser.add_argument("--display-name", default="WhatsApp Approval E2E")
    parser.add_argument("--prompt", default="请读取附件并汇总销售额")
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
            prompt=args.prompt,
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
