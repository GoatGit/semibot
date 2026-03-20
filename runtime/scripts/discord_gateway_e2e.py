#!/usr/bin/env python3
"""Live Discord gateway E2E helper.

This script configures a Discord channel instance, sends a setup message through
Semibot, then waits for a real user reply to validate the live inbound -> runtime
-> outbound loop.

Typical usage:
  runtime/.venv/bin/python runtime/scripts/discord_gateway_e2e.py \
    --runtime-url http://127.0.0.1:8765 \
    --bot-token "$DISCORD_BOT_TOKEN" \
    --bot-user-id "$DISCORD_BOT_USER_ID" \
    --channel-id "$DISCORD_CHANNEL_ID"
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


def _upsert_discord_instance(
    runtime_url: str,
    *,
    instance_key: str,
    display_name: str,
    bot_token: str,
    bot_user_id: str,
    channel_id: str,
    guild_id: str | None,
) -> dict[str, Any]:
    existing = _find_instance(runtime_url, provider="discord", instance_key=instance_key)
    payload = {
        "provider": "discord",
        "instanceKey": instance_key,
        "displayName": display_name,
        "isActive": True,
        "mode": "gateway",
        "config": {
            "botToken": bot_token,
            "botUserId": bot_user_id,
            "defaultChannelId": channel_id,
            "allowedChannelIds": [channel_id],
            "allowedGuildIds": [guild_id] if guild_id else [],
        },
    }
    if existing:
        instance_id = str(existing.get("id") or "").strip()
        if not instance_id:
            raise RuntimeError("existing discord instance missing id")
        return _runtime_put(runtime_url, f"/v1/config/gateway-instances/{instance_id}", payload)
    return _runtime_post(runtime_url, "/v1/config/gateway-instances", payload)


def _send_setup_message(runtime_url: str, *, instance_id: str, token: str) -> dict[str, Any]:
    prompt = (
        "Semibot Discord E2E 已启动。\n"
        f"请在当前频道回复这串校验码：`{token}`\n"
        "脚本会等待真实入站消息并验证执行结果。"
    )
    return _runtime_post(
        runtime_url,
        f"/v1/config/gateway-instances/{instance_id}/test",
        {"text": prompt},
    )


def _find_conversation(runtime_url: str, *, gateway_key: str) -> str | None:
    payload = _runtime_get(runtime_url, "/v1/gateway/conversations", {"provider": "discord", "limit": 100})
    rows = payload.get("data") if isinstance(payload.get("data"), list) else []
    for item in rows:
        if not isinstance(item, dict):
            continue
        if str(item.get("gateway_key") or "").strip() == gateway_key:
            cid = str(item.get("conversation_id") or "").strip()
            if cid:
                return cid
    return None


def _get_context(runtime_url: str, conversation_id: str) -> list[dict[str, Any]]:
    payload = _runtime_get(runtime_url, f"/v1/gateway/conversations/{conversation_id}/context", {"limit": 200})
    return payload.get("messages") if isinstance(payload.get("messages"), list) else []


def _get_runs(runtime_url: str, conversation_id: str) -> list[dict[str, Any]]:
    payload = _runtime_get(runtime_url, f"/v1/gateway/conversations/{conversation_id}/runs", {"limit": 20})
    return payload.get("data") if isinstance(payload.get("data"), list) else []


def run_check(
    *,
    runtime_url: str,
    bot_token: str,
    bot_user_id: str,
    channel_id: str,
    guild_id: str | None,
    instance_key: str,
    display_name: str,
    timeout_sec: int,
    poll_interval_sec: float,
) -> CheckResult:
    instance = _upsert_discord_instance(
        runtime_url,
        instance_key=instance_key,
        display_name=display_name,
        bot_token=bot_token,
        bot_user_id=bot_user_id,
        channel_id=channel_id,
        guild_id=guild_id,
    )
    instance_id = str(instance.get("id") or "").strip()
    if not instance_id:
        return CheckResult(False, "discord instance upsert failed", {"instance": instance})

    token = f"semibot-discord-e2e-{secrets.token_hex(4)}"
    send_result = _send_setup_message(runtime_url, instance_id=instance_id, token=token)
    if send_result.get("sent") is not True:
        return CheckResult(False, "setup message send failed", {"instance_id": instance_id, "send_result": send_result})

    gateway_key = f"discord:{bot_user_id}:{channel_id}"
    deadline = time.time() + timeout_sec
    conversation_id: str | None = None
    matched_user_message: dict[str, Any] | None = None
    matched_run: dict[str, Any] | None = None
    matched_assistant: dict[str, Any] | None = None

    while time.time() < deadline:
        conversation_id = _find_conversation(runtime_url, gateway_key=gateway_key)
        if conversation_id:
            messages = _get_context(runtime_url, conversation_id)
            for item in reversed(messages):
                if not isinstance(item, dict):
                    continue
                if str(item.get("role") or "") == "user" and token in str(item.get("content") or ""):
                    matched_user_message = item
                    break
            if matched_user_message:
                runs = _get_runs(runtime_url, conversation_id)
                if runs:
                    matched_run = runs[0] if isinstance(runs[0], dict) else None
                for item in reversed(messages):
                    if not isinstance(item, dict):
                        continue
                    if str(item.get("role") or "") == "assistant":
                        content = str(item.get("content") or "")
                        if token in content or content.startswith("已收到任务") or content.startswith("done:"):
                            matched_assistant = item
                            break
                if matched_assistant and matched_run:
                    break
        time.sleep(poll_interval_sec)

    if not conversation_id:
        return CheckResult(
            False,
            "conversation not found; confirm discord bridge is running and channel is correct",
            {"instance_id": instance_id, "gateway_key": gateway_key, "token": token},
        )
    if not matched_user_message:
        return CheckResult(
            False,
            "no live inbound user reply observed; reply in Discord with the printed token",
            {"conversation_id": conversation_id, "gateway_key": gateway_key, "token": token},
        )

    return CheckResult(
        True,
        "discord live E2E observed inbound message",
        {
            "instance_id": instance_id,
            "gateway_key": gateway_key,
            "conversation_id": conversation_id,
            "token": token,
            "send_result": send_result,
            "user_message": matched_user_message,
            "run": matched_run,
            "assistant_message": matched_assistant,
        },
    )


def main() -> int:
    parser = argparse.ArgumentParser(description="Discord live gateway E2E helper")
    parser.add_argument("--runtime-url", default="http://127.0.0.1:8765")
    parser.add_argument("--bot-token", required=True)
    parser.add_argument("--bot-user-id", required=True)
    parser.add_argument("--channel-id", required=True)
    parser.add_argument("--guild-id", default=None)
    parser.add_argument("--instance-key", default="discord-e2e")
    parser.add_argument("--display-name", default="Discord E2E")
    parser.add_argument("--timeout-sec", type=int, default=120)
    parser.add_argument("--poll-interval-sec", type=float, default=2.0)
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()

    try:
        result = run_check(
            runtime_url=args.runtime_url,
            bot_token=args.bot_token,
            bot_user_id=args.bot_user_id,
            channel_id=args.channel_id,
            guild_id=args.guild_id,
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
        if result.ok:
            print("\n下一步：在 Discord 频道里回复上面的 token，或查看 assistant_message / run。")
        else:
            print("\n如果是 live inbound 超时，请确认：")
            print("1. runtime 已启动且 Discord supervisor 正常")
            print("2. 该实例 mode=gateway 且 token/botUserId/channelId 正确")
            print("3. 你在真实 Discord 频道内回复了 token")
    return 0 if result.ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
