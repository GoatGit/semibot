"""Step-scoped loop detection for repeated ACT tool calls."""

from __future__ import annotations

import hashlib
import json
import os
import re
from typing import Any

from src.orchestrator.runtime_middleware import RuntimeSignal
from src.orchestrator.state import ToolCallResult

_WARN_THRESHOLD = int(os.getenv("SEMIBOT_ACT_LOOP_WARN_THRESHOLD") or "3")
_BLOCK_THRESHOLD = int(os.getenv("SEMIBOT_ACT_LOOP_BLOCK_THRESHOLD") or "4")
_HARD_STOP_THRESHOLD = int(os.getenv("SEMIBOT_ACT_LOOP_HARD_STOP_THRESHOLD") or "5")
_FAILURE_REPEAT_THRESHOLD = int(os.getenv("SEMIBOT_ACT_LOOP_FAILURE_THRESHOLD") or "2")


def _normalize_text(value: str, *, max_len: int = 160) -> str:
    compact = re.sub(r"\s+", " ", str(value or "").strip())
    return compact[:max_len]


def _normalize_tool_params(tool_name: str, params: dict[str, Any]) -> dict[str, Any]:
    tool = str(tool_name or "").strip()
    normalized = dict(params or {})
    if tool in {"search", "web_search", "search_query", "web.search"}:
        query = normalized.get("query")
        if not query and isinstance(normalized.get("queries"), list):
            query = (normalized.get("queries") or [None])[0]
        return {"query": _normalize_text(str(query or ""))}
    if tool == "file_io":
        return {
            "action": str(normalized.get("action") or normalized.get("operation") or "").strip().lower(),
            "path": _normalize_text(str(normalized.get("path") or ""), max_len=240),
            "scope": str(normalized.get("scope") or "").strip().lower(),
        }
    if tool in {"code_executor", "shell", "bash"}:
        return {
            "command": _normalize_text(str(normalized.get("command") or normalized.get("cmd") or "")),
            "path": _normalize_text(str(normalized.get("path") or normalized.get("cwd") or ""), max_len=240),
            "filename": _normalize_text(str(normalized.get("filename") or ""), max_len=120),
        }

    def _normalize(value: Any) -> Any:
        if isinstance(value, str):
            return _normalize_text(value)
        if isinstance(value, dict):
            return {str(key): _normalize(value[key]) for key in sorted(value)}
        if isinstance(value, list):
            return [_normalize(item) for item in value[:10]]
        return value

    return _normalize(normalized)


def compute_tool_call_hash(tool_name: str, params: dict[str, Any]) -> str:
    payload = {
        "tool_name": str(tool_name or "").strip(),
        "params": _normalize_tool_params(tool_name, params),
    }
    digest = hashlib.sha1(json.dumps(payload, sort_keys=True, ensure_ascii=False).encode("utf-8")).hexdigest()
    return f"{payload['tool_name']}:{digest}"


def evaluate_tool_call(step_loop_guard: dict[str, Any], tool_name: str, params: dict[str, Any]) -> tuple[str, RuntimeSignal]:
    call_hash = compute_tool_call_hash(tool_name, params)
    repeat_map = step_loop_guard.setdefault("repeat_count_by_hash", {})
    blocked_hashes = step_loop_guard.setdefault("blocked_hashes", [])
    warned_hashes = step_loop_guard.setdefault("warned_hashes", [])
    hard_stopped_hashes = step_loop_guard.setdefault("hard_stopped_hashes", [])
    count = int(repeat_map.get(call_hash) or 0) + 1
    repeat_map[call_hash] = count

    if call_hash in blocked_hashes or count >= _BLOCK_THRESHOLD:
        if call_hash not in blocked_hashes:
            blocked_hashes.append(call_hash)
        signal = RuntimeSignal(
            kind="block" if count < _HARD_STOP_THRESHOLD else "hard_stop",
            source="loop_detection",
            reason="repeated_tool_call",
            message=f"Repeated tool call blocked for {tool_name}",
            data={"tool_name": tool_name, "call_hash": call_hash, "repeat_count": count},
        )
        if signal.kind == "hard_stop" and call_hash not in hard_stopped_hashes:
            hard_stopped_hashes.append(call_hash)
        step_loop_guard["last_loop_signal"] = signal.to_dict()
        return call_hash, signal
    if count >= _WARN_THRESHOLD:
        if call_hash not in warned_hashes:
            warned_hashes.append(call_hash)
        signal = RuntimeSignal(
            kind="warn",
            source="loop_detection",
            reason="repeated_tool_call",
            message=f"Tool call is repeating for {tool_name}; switch strategy or finish the step",
            data={"tool_name": tool_name, "call_hash": call_hash, "repeat_count": count},
        )
        step_loop_guard["last_loop_signal"] = signal.to_dict()
        return call_hash, signal
    return call_hash, RuntimeSignal(kind="allow", source="loop_detection", reason="new_tool_call")


def register_tool_result(step_loop_guard: dict[str, Any], tool_name: str, params: dict[str, Any], result: ToolCallResult) -> RuntimeSignal:
    call_hash = compute_tool_call_hash(tool_name, params)
    if result.success:
        step_loop_guard["last_success_hash"] = call_hash
        return RuntimeSignal(kind="emit_only", source="loop_detection", reason="tool_call_succeeded", data={"call_hash": call_hash})
    error_text = str(result.error or "").strip().lower()
    if "timeout" in error_text:
        failure_kind = "timeout"
    elif "permission" in error_text or "denied" in error_text:
        failure_kind = "permission_denied"
    elif "validation" in error_text or ((result.metadata or {}).get("guard")):
        failure_kind = "validation_rejected"
    elif "unavailable" in error_text or "not configured" in error_text:
        failure_kind = "provider_unavailable"
    else:
        failure_kind = "execution_error"
    failure_hash = f"{call_hash}:{failure_kind}"
    repeat_map = step_loop_guard.setdefault("failure_repeat_count_by_hash", {})
    count = int(repeat_map.get(failure_hash) or 0) + 1
    repeat_map[failure_hash] = count
    if count >= _FAILURE_REPEAT_THRESHOLD:
        blocked_hashes = step_loop_guard.setdefault("blocked_hashes", [])
        if call_hash not in blocked_hashes:
            blocked_hashes.append(call_hash)
        signal = RuntimeSignal(
            kind="block",
            source="loop_detection",
            reason="repeated_failed_call",
            message=f"Repeated failed tool call blocked for {tool_name}",
            data={"tool_name": tool_name, "call_hash": call_hash, "failure_kind": failure_kind, "repeat_count": count},
        )
        step_loop_guard["last_loop_signal"] = signal.to_dict()
        return signal
    return RuntimeSignal(kind="emit_only", source="loop_detection", reason="tool_call_failed", data={"call_hash": call_hash, "failure_kind": failure_kind, "repeat_count": count})


def build_loop_guard_failure_result(*, tool_name: str, params: dict[str, Any], signal: RuntimeSignal) -> ToolCallResult:
    return ToolCallResult(
        tool_name=tool_name or "llm_act",
        params=params or {},
        error=signal.message or "Repeated tool call blocked by ACT loop guard",
        success=False,
        metadata={
            "guard": "act_loop_guard",
            "runtime_signal": signal.to_dict(),
            "call_hash": str(signal.data.get("call_hash") or ""),
        },
    )
