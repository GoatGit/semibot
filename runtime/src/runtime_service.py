"""Runtime execution service facade.

This module preserves the stable HTTP-facing `run_task_once(...)` contract
while routing one-off task execution through the semigraph session runtime.
"""

from __future__ import annotations

import asyncio
from contextlib import suppress
from pathlib import Path
from typing import Any
from uuid import uuid4

from src.local_runtime import (
    _guard_rule_authoring_success_claim,
    _maybe_bootstrap_llm_from_control_plane,
    _maybe_load_local_env_files,
)
from src.server.config_store import RuntimeConfigStore

__all__ = ["run_task_once"]


def _build_local_init_data(*, db_path: str, rules_path: str) -> dict[str, Any]:
    store = RuntimeConfigStore(db_path=db_path)
    llm_config = store.get_llm_settings()
    providers = llm_config.get("providers") if isinstance(llm_config, dict) else {}
    api_keys: dict[str, str] = {}
    if isinstance(providers, dict):
        for provider_key, raw_cfg in providers.items():
            if not isinstance(raw_cfg, dict):
                continue
            api_key = str(raw_cfg.get("api_key") or raw_cfg.get("apiKey") or "").strip()
            key_name = str(provider_key or "").strip()
            if key_name and api_key:
                api_keys[key_name] = api_key

    return {
        "user_id": "local",
        "api_keys": api_keys,
        "llm_config": llm_config if isinstance(llm_config, dict) else {},
        "memory_dir": str(Path("~/.semibot/sessions").expanduser()),
        "events_db_path": db_path,
        "rules_path": rules_path,
    }


class _LocalSemigraphClient:
    def __init__(self, runtime_event_callback: Any | None = None) -> None:
        self.runtime_event_callback = runtime_event_callback
        self.runtime_events: list[dict[str, Any]] = []
        self.sse_events: list[dict[str, Any]] = []
        self.snapshots: dict[str, dict[str, Any]] = {}
        self._done = asyncio.Event()
        self.terminal_payload: dict[str, Any] | None = None

    async def send_sse_event(self, session_id: str, payload: dict[str, Any]) -> None:
        item = {"session_id": session_id, **payload}
        self.sse_events.append(item)
        event_type = str(payload.get("type") or "").strip()
        if event_type in {"execution_complete", "execution_error"}:
            self.terminal_payload = item
            self._done.set()

    async def send_runtime_event(self, session_id: str, event: dict[str, Any]) -> None:
        raw_item = {"session_id": session_id, **event}
        self.runtime_events.append(raw_item)
        flattened = {
            "session_id": session_id,
            "event": str(event.get("event") or ""),
            "timestamp": event.get("timestamp"),
        }
        data = event.get("data")
        if isinstance(data, dict):
            flattened.update(data)
        if self.runtime_event_callback:
            with suppress(Exception):
                await self.runtime_event_callback(flattened)

    async def fire_and_forget(self, session_id: str, method: str, **params: Any) -> None:
        if method == "snapshot_sync":
            self.snapshots[session_id] = dict(params)

    async def request(self, session_id: str, method: str, **params: Any) -> Any:
        del session_id, params
        if method == "memory_search":
            return {"results": []}
        if method == "get_skill_package":
            return {}
        return {}


def _serialize_tool_results_from_events(runtime_events: list[dict[str, Any]]) -> list[dict[str, Any]]:
    serialized: list[dict[str, Any]] = []
    for item in runtime_events:
        if str(item.get("event") or "") != "tool_call_complete":
            continue
        metadata = item.get("metadata") if isinstance(item.get("metadata"), dict) else {}
        serialized.append(
            {
                "tool_name": str(item.get("tool_name") or "").strip(),
                "params": {},
                "result": item.get("result"),
                "error": item.get("error"),
                "duration_ms": int(item.get("duration") or 0),
                "success": bool(item.get("success")),
                "metadata": metadata,
            }
        )
    return serialized


async def run_task_once(
    *,
    task: str,
    db_path: str,
    rules_path: str,
    agent_id: str = "semibot",
    session_id: str | None = None,
    approval_scope_id: str | None = None,
    model: str | None = None,
    model_provider_key: str | None = None,
    fallback_model: str | None = None,
    fallback_provider_key: str | None = None,
    system_prompt: str | None = None,
    skill_index: list[dict[str, Any]] | None = None,
    model_roles: dict[str, Any] | None = None,
    runtime_event_callback: Any | None = None,
) -> dict[str, Any]:
    del approval_scope_id
    _maybe_load_local_env_files()
    await _maybe_bootstrap_llm_from_control_plane()

    resolved_session_id = session_id or f"local_{uuid4().hex}"
    client = _LocalSemigraphClient(runtime_event_callback=runtime_event_callback)
    init_data = _build_local_init_data(db_path=db_path, rules_path=rules_path)
    start_payload = {
        "session_id": resolved_session_id,
        "runtime_type": "semigraph",
        "agent_id": agent_id,
        "agent_config": {
            "id": agent_id,
            "name": agent_id,
            "model": model,
            "model_provider_key": model_provider_key,
            "fallback_model": fallback_model,
            "fallback_provider_key": fallback_provider_key,
            "system_prompt": system_prompt,
            "model_roles": model_roles,
        },
        "skill_index": [row for row in skill_index if isinstance(row, dict)] if isinstance(skill_index, list) else [],
        "events_db_path": db_path,
        "rules_path": rules_path,
    }

    from src.session.semigraph_adapter import SemiGraphAdapter

    adapter = SemiGraphAdapter(
        client=client,  # type: ignore[arg-type]
        session_id=resolved_session_id,
        init_data=init_data,
        start_payload=start_payload,
        user_id="local",
    )

    await adapter.start()
    try:
        await adapter.handle_user_message({"message": task, "metadata": {"entrypoint": "runtime_service.run_task_once"}})
        task_handle = adapter._task
        if task_handle is not None:
            await task_handle
        else:
            await client._done.wait()

        snapshot = await adapter.get_snapshot()
        checkpoint = snapshot.get("checkpoint") if isinstance(snapshot, dict) else {}
        checkpoint = checkpoint if isinstance(checkpoint, dict) else {}

        tool_results = checkpoint.get("tool_results") if isinstance(checkpoint.get("tool_results"), list) else []
        if not tool_results:
            tool_results = _serialize_tool_results_from_events(client.runtime_events)

        error = str(checkpoint.get("error") or "").strip() or None

        terminal = client.terminal_payload or {}
        terminal_type = str(terminal.get("type") or "").strip()
        final_response = str(
            checkpoint.get("final_response")
            or terminal.get("final_response")
            or ""
        )
        final_response = _guard_rule_authoring_success_claim(
            final_response,
            tool_results if isinstance(tool_results, list) else [],
        )

        status = "failed" if error or terminal_type == "execution_error" else str(checkpoint.get("status") or "completed")
        if status not in {"completed", "failed", "cancelled"}:
            status = "failed" if error else "completed"

        return {
            "status": status,
            "session_id": resolved_session_id,
            "agent_id": agent_id,
            "final_response": final_response,
            "error": error,
            "tool_results": tool_results if isinstance(tool_results, list) else [],
            "runtime_events": client.runtime_events,
            "llm_configured": adapter.llm_provider is not None,
        }
    except Exception as exc:
        return {
            "status": "failed",
            "session_id": resolved_session_id,
            "agent_id": agent_id,
            "final_response": "",
            "error": str(exc),
            "tool_results": _serialize_tool_results_from_events(client.runtime_events),
            "runtime_events": client.runtime_events,
            "llm_configured": adapter.llm_provider is not None,
        }
    finally:
        with suppress(Exception):
            await adapter.stop()
