#!/usr/bin/env python3
"""One-command Telegram gateway smoke test.

Workflow:
1) Validate local gateway config health.
2) (Optional) Set webhook URL via Telegram Bot API.
3) Verify webhook registration and pending queue.
4) (Optional) Send runtime test message through selected gateway instance.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any


@dataclass
class StepResult:
    name: str
    ok: bool
    exit_code: int
    payload: dict[str, Any] | None
    raw_stdout: str
    raw_stderr: str


def _runtime_root() -> Path:
    # runtime/scripts/telegram_gateway_smoke.py -> runtime/
    return Path(__file__).resolve().parents[1]


def _run_semibot(cli_python: str, args: list[str]) -> StepResult:
    command = [cli_python, "-m", "src.cli", "--json", *args]
    proc = subprocess.run(
        command,
        cwd=str(_runtime_root()),
        capture_output=True,
        text=True,
        check=False,
    )
    stdout = proc.stdout.strip()
    payload: dict[str, Any] | None = None
    if stdout:
        lines = [line for line in stdout.splitlines() if line.strip()]
        if lines:
            try:
                parsed = json.loads(lines[-1])
                if isinstance(parsed, dict):
                    payload = parsed
            except json.JSONDecodeError:
                payload = None
    step_name = " ".join(args[:2]) if len(args) >= 2 else " ".join(args)
    return StepResult(
        name=step_name,
        ok=proc.returncode == 0,
        exit_code=proc.returncode,
        payload=payload,
        raw_stdout=proc.stdout,
        raw_stderr=proc.stderr,
    )


def _print_step(title: str, result: StepResult) -> None:
    status = "OK" if result.ok else "FAIL"
    print(f"[{status}] {title} (exit={result.exit_code})")
    if result.payload:
        hint = result.payload.get("hint")
        summary = result.payload.get("summary")
        error = result.payload.get("error")
        if isinstance(summary, dict):
            compact = ", ".join(f"{k}={v}" for k, v in summary.items())
            print(f"      summary: {compact}")
        if isinstance(error, dict):
            code = error.get("code")
            message = error.get("message")
            print(f"      error: {code} - {message}")
        elif hint:
            print(f"      hint: {hint}")
    if not result.ok and result.raw_stderr.strip():
        print(f"      stderr: {result.raw_stderr.strip()}")


def _select_instance_id(
    preferred: str | None,
    doctor_payload: dict[str, Any] | None,
    webhook_set_payload: dict[str, Any] | None,
) -> str | None:
    if preferred:
        return preferred
    if isinstance(webhook_set_payload, dict):
        instance = webhook_set_payload.get("instance")
        if isinstance(instance, dict):
            value = instance.get("id")
            if isinstance(value, str) and value.strip():
                return value.strip()
    if isinstance(doctor_payload, dict):
        instances = doctor_payload.get("instances")
        if isinstance(instances, list) and instances:
            for item in instances:
                if not isinstance(item, dict):
                    continue
                value = item.get("id")
                if isinstance(value, str) and value.strip():
                    return value.strip()
    return None


def main() -> int:
    parser = argparse.ArgumentParser(description="Telegram gateway smoke test")
    parser.add_argument("--db-path", default=str(Path("~/.semibot/semibot.db").expanduser()))
    parser.add_argument("--runtime-url", default="http://127.0.0.1:8765")
    parser.add_argument("--instance-id", default=None, help="Optional gateway instance id")
    parser.add_argument("--public-base-url", default=None, help="e.g. https://xxxx.ngrok-free.app")
    parser.add_argument("--webhook-url", default=None, help="explicit webhook url")
    parser.add_argument("--strict-warnings", action="store_true")
    parser.add_argument("--skip-webhook-set", action="store_true")
    parser.add_argument("--skip-runtime-test", action="store_true")
    parser.add_argument("--test-text", default="Semibot telegram gateway smoke test")
    parser.add_argument("--chat-id", default=None, help="optional chat id for gateway test")
    parser.add_argument(
        "--python",
        default=sys.executable,
        help="Python executable for `python -m src.cli` (default: current python)",
    )
    args = parser.parse_args()

    if not args.skip_webhook_set and not args.webhook_url and not args.public_base_url:
        print("ERROR: provide --webhook-url or --public-base-url when webhook set is enabled.")
        return 2

    summary: dict[str, Any] = {"ok": True, "steps": []}
    failed = False

    doctor_args = ["gateway", "doctor", "--provider", "telegram", "--db-path", args.db_path]
    if args.strict_warnings:
        doctor_args.append("--strict-warnings")
    doctor_res = _run_semibot(args.python, doctor_args)
    _print_step("Gateway doctor", doctor_res)
    summary["steps"].append({"name": "gateway_doctor", "exit": doctor_res.exit_code, "ok": doctor_res.ok})
    if not doctor_res.ok:
        failed = True

    webhook_set_res: StepResult | None = None
    if not args.skip_webhook_set and not failed:
        set_args = ["gateway", "webhook-set", "--provider", "telegram", "--db-path", args.db_path]
        if args.instance_id:
            set_args.extend(["--instance-id", args.instance_id])
        if args.webhook_url:
            set_args.extend(["--url", args.webhook_url])
        elif args.public_base_url:
            set_args.extend(["--public-base-url", args.public_base_url])
        webhook_set_res = _run_semibot(args.python, set_args)
        _print_step("Webhook set", webhook_set_res)
        summary["steps"].append({"name": "webhook_set", "exit": webhook_set_res.exit_code, "ok": webhook_set_res.ok})
        if not webhook_set_res.ok:
            failed = True

    selected_instance_id = _select_instance_id(
        args.instance_id,
        doctor_res.payload,
        webhook_set_res.payload if webhook_set_res else None,
    )
    if not selected_instance_id and not failed:
        print("ERROR: cannot resolve telegram gateway instance id (use --instance-id).")
        failed = True

    webhook_check_args = ["gateway", "webhook-check", "--provider", "telegram", "--db-path", args.db_path]
    if selected_instance_id:
        webhook_check_args.extend(["--instance-id", selected_instance_id])
    if args.webhook_url:
        webhook_check_args.extend(["--expected-url", args.webhook_url])
    elif args.public_base_url:
        webhook_check_args.extend(["--public-base-url", args.public_base_url])
    if args.strict_warnings:
        webhook_check_args.append("--strict-warnings")
    webhook_check_res = _run_semibot(args.python, webhook_check_args)
    _print_step("Webhook check", webhook_check_res)
    summary["steps"].append({"name": "webhook_check", "exit": webhook_check_res.exit_code, "ok": webhook_check_res.ok})
    if not webhook_check_res.ok:
        failed = True

    if not args.skip_runtime_test and not failed and selected_instance_id:
        test_args = [
            "gateway",
            "test",
            selected_instance_id,
            "--text",
            args.test_text,
            "--server-url",
            args.runtime_url,
        ]
        if args.chat_id:
            test_args.extend(["--chat-id", args.chat_id])
        test_res = _run_semibot(args.python, test_args)
        _print_step("Runtime gateway test", test_res)
        summary["steps"].append({"name": "runtime_gateway_test", "exit": test_res.exit_code, "ok": test_res.ok})
        if not test_res.ok:
            failed = True

    summary["instance_id"] = selected_instance_id
    summary["ok"] = not failed
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 0 if summary["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
