from __future__ import annotations

from typing import Any

from src.product.services import (
    LocalProductStack,
    LocalRuntimeServiceManager,
    RuntimeServiceOptions,
    StackOptions,
)


def _build_stack(options: StackOptions) -> LocalProductStack:
    return LocalProductStack(options)


def build_product_status_payload(options: StackOptions) -> dict[str, Any]:
    stack = _build_stack(options)
    payload = stack.status_payload()
    services = payload.get("services") or []
    running = len([item for item in services if item.get("status") not in {"stopped"}])
    stopped = len([item for item in services if item.get("status") == "stopped"])
    return {
        "ok": True,
        "resource": "stack",
        "action": "status",
        **payload,
        "summary": {
            "status": payload.get("status"),
            "running_services": running,
            "stopped_services": stopped,
            "ui_url": payload.get("ui_url"),
            "project_root": payload.get("project_root"),
            "launch_mode": payload.get("launch_mode"),
            "active_release": (payload.get("release") or {}).get("active_version"),
        },
        "suggested_actions": (
            ["Run `semibot up` to start all local services."]
            if payload.get("status") in {"stopped", "degraded"}
            else []
        ),
    }


def build_product_logs_payload(options: StackOptions, *, service: str | None, lines: int) -> dict[str, Any]:
    stack = _build_stack(options)
    return {
        "resource": "stack",
        "action": "logs",
        **stack.logs_payload(service=service, lines=lines),
    }


def build_product_up_payload(options: StackOptions) -> dict[str, Any]:
    stack = _build_stack(options)
    return {"resource": "stack", "action": "up", **stack.start()}


def build_product_down_payload(options: StackOptions) -> dict[str, Any]:
    stack = _build_stack(options)
    return {"resource": "stack", "action": "down", **stack.stop()}


def build_product_ui_payload(options: StackOptions, *, action: str, should_open: bool) -> dict[str, Any]:
    stack = _build_stack(options)
    if action == "open":
        return {"resource": "ui", "action": "open", **stack.open_ui(should_open=should_open)}
    if action == "start":
        return {"resource": "ui", "action": "start", **stack.start()}
    if action == "stop":
        return {"resource": "ui", "action": "stop", **stack.stop()}
    if action == "restart":
        return {"resource": "ui", "action": "restart", **stack.restart()}
    raise RuntimeError(f"unsupported ui action: {action}")


def build_runtime_service_payload(options: RuntimeServiceOptions, *, action: str) -> dict[str, Any]:
    manager = LocalRuntimeServiceManager(options)
    if action == "status":
        payload = manager.status_payload()
        payload["summary"] = {
            "status": payload.get("status"),
            "host": payload.get("host"),
            "port": payload.get("port"),
            "name": payload.get("name"),
            "manager": payload.get("manager"),
        }
        payload["resource"] = "runtime"
        payload["action"] = "status"
        return payload
    if action == "start":
        return {"resource": "runtime", "action": "start", **manager.start()}
    if action == "stop":
        return {"resource": "runtime", "action": "stop", **manager.stop()}
    if action == "restart":
        return {"resource": "runtime", "action": "restart", **manager.restart()}
    raise RuntimeError(f"unsupported serve action: {action}")
