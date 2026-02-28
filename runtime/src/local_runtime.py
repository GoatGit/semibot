"""Local one-off runtime execution for Semibot V2 CLI."""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import re
import time
import tomllib
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from uuid import uuid4

from src.bootstrap import default_config_path
from src.events.event_engine import EventEngine
from src.events.event_router import EventRouter
from src.events.event_store import EventStore
from src.events.models import Event
from src.events.runtime_action_executor import RuntimeActionExecutor
from src.llm.base import LLMConfig
from src.llm.openai_provider import OpenAIProvider
from src.orchestrator.context import (
    AgentConfig,
    RuntimePolicy,
    RuntimeSessionContext,
    SkillDefinition,
    ToolDefinition,
)
from src.orchestrator.graph import create_agent_graph
from src.orchestrator.state import create_initial_state
from src.orchestrator.unified_executor import UnifiedActionExecutor
from src.security.api_key_cipher import decrypt_api_keys
from src.server.config_store import RuntimeConfigStore
from src.skills.bootstrap import create_default_registry
from src.skills.registry import SkillRegistry
from src.utils.logging import get_logger
from src.ws.client import ControlPlaneClient

DEFAULT_CONTROL_PLANE_WS = "ws://127.0.0.1:3001/ws/vm"
logger = get_logger(__name__)

_CONTROL_PLANE_BOOTSTRAP_LOCK: asyncio.Lock | None = None
_CONTROL_PLANE_BOOTSTRAP_LAST_ATTEMPT = 0.0
_CONTROL_PLANE_BOOTSTRAP_RETRY_COOLDOWN_SECONDS = 15.0
_LOCAL_ENV_BOOTSTRAP_DONE = False

_ENV_KEY_PATTERN = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
_APPROVAL_SCOPE_ALLOWED = {"call", "action", "target", "session", "session_action", "tool"}
_APPROVAL_ACTION_KEYS = ("action", "operation", "method", "mode", "type")
_APPROVAL_TARGET_KEYS = (
    "url",
    "path",
    "target",
    "selector",
    "query",
    "command",
    "resource",
    "file",
    "filename",
    "name",
)
_APPROVAL_SUMMARY_IGNORED_PARAMS = {
    "content",
    "text",
    "code",
    "html",
    "script",
    "prompt",
    "messages",
    "input",
    "body",
}


def _as_non_empty_str(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    trimmed = value.strip()
    return trimmed or None


def _short_text(value: Any, *, max_len: int = 120) -> str:
    text = str(value or "").strip()
    if len(text) <= max_len:
        return text
    return f"{text[: max_len - 1]}…"


def _extract_first_string(params: dict[str, Any], keys: tuple[str, ...]) -> str:
    for key in keys:
        value = params.get(key)
        if value is None:
            continue
        if isinstance(value, str) and value.strip():
            return value.strip()
        if isinstance(value, (int, float, bool)):
            return str(value)
    return ""


def _normalize_dedupe_keys(raw: Any) -> list[str]:
    if not isinstance(raw, list):
        return []
    normalized: list[str] = []
    for item in raw:
        if not isinstance(item, str):
            continue
        key = item.strip()
        if key:
            normalized.append(key)
    return normalized


def _summarize_params(params: dict[str, Any], *, max_items: int = 3) -> dict[str, str]:
    summary: dict[str, str] = {}
    for key in sorted(params.keys()):
        if key in _APPROVAL_SUMMARY_IGNORED_PARAMS:
            continue
        value = params.get(key)
        if isinstance(value, str):
            stripped = value.strip()
            if not stripped:
                continue
            summary[key] = _short_text(stripped, max_len=60)
        elif isinstance(value, (int, float, bool)):
            summary[key] = str(value)
        if len(summary) >= max_items:
            break
    return summary


def _build_approval_policy(
    tool_name: str,
    params: dict[str, Any],
    risk_level: str,
    session_id: str,
    metadata_additional: dict[str, Any] | None = None,
) -> tuple[str, dict[str, Any]]:
    metadata_additional = metadata_additional or {}
    action = _extract_first_string(params, _APPROVAL_ACTION_KEYS).lower()
    target = _short_text(_extract_first_string(params, _APPROVAL_TARGET_KEYS), max_len=120)
    params_preview = _summarize_params(params)

    scope_raw = str(metadata_additional.get("approval_scope") or "").strip().lower()
    approval_scope = scope_raw if scope_raw in _APPROVAL_SCOPE_ALLOWED else "session"
    dedupe_keys = _normalize_dedupe_keys(metadata_additional.get("approval_dedupe_keys"))

    context: dict[str, Any] = {
        "tool_name": tool_name,
        "action": action or None,
        "target": target or None,
        "risk_level": risk_level,
        "session_id": session_id,
        "params_preview": params_preview,
    }
    context["summary"] = (
        f"工具 `{tool_name}`"
        f"{f' 执行动作 `{action}`' if action else ''}"
        f"{f'，目标 `{target}`' if target else ''}"
    )

    if dedupe_keys:
        grouped_values: list[str] = []
        for key in dedupe_keys:
            value = params.get(key)
            if value is None:
                continue
            grouped_values.append(f"{key}={_short_text(value, max_len=80)}")
        grouped = "|".join(grouped_values) if grouped_values else "none"
        return f"{tool_name}|risk:{risk_level}|custom:{grouped}", context

    if approval_scope == "tool":
        return f"{tool_name}|risk:{risk_level}", context
    if approval_scope == "session":
        return f"{tool_name}|risk:{risk_level}|session:{session_id}", context
    if approval_scope == "action":
        return f"{tool_name}|risk:{risk_level}|action:{action or 'none'}", context
    if approval_scope == "target":
        return f"{tool_name}|risk:{risk_level}|action:{action or 'none'}|target:{target or 'none'}", context
    if approval_scope == "call":
        try:
            serialized = json.dumps(params, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        except Exception:
            serialized = str(params)
        call_hash = hashlib.sha256(serialized.encode()).hexdigest()[:16]
        return f"{tool_name}|risk:{risk_level}|call:{call_hash}", context

    # Default: one approval per (tool + session + action), generic and low-noise.
    return f"{tool_name}|risk:{risk_level}|session:{session_id}|action:{action or 'none'}", context


def _runtime_root() -> Path:
    return Path(__file__).resolve().parents[1]


def _repo_root() -> Path:
    return Path(__file__).resolve().parents[2]


def _parse_env_value(raw: str) -> str:
    value = raw.strip()
    if not value:
        return ""
    if " #" in value:
        value = value.split(" #", maxsplit=1)[0].strip()
    if (value.startswith('"') and value.endswith('"')) or (value.startswith("'") and value.endswith("'")):
        return value[1:-1]
    return value


def _load_env_file(path: Path) -> None:
    if not path.exists():
        return
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except Exception:
        return
    for raw in lines:
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[7:].strip()
        if "=" not in line:
            continue
        key, value = line.split("=", maxsplit=1)
        key = key.strip()
        if not _ENV_KEY_PATTERN.match(key):
            continue
        if os.getenv(key):
            continue
        os.environ[key] = _parse_env_value(value)


def _maybe_load_local_env_files() -> None:
    global _LOCAL_ENV_BOOTSTRAP_DONE
    if _LOCAL_ENV_BOOTSTRAP_DONE:
        return
    _LOCAL_ENV_BOOTSTRAP_DONE = True

    env_files = [
        _repo_root() / ".env.local",
        _repo_root() / ".env",
        _runtime_root() / ".env.local",
        _runtime_root() / ".env",
    ]
    for env_file in env_files:
        _load_env_file(env_file)


def _load_llm_config() -> dict[str, Any]:
    config_path = os.getenv("SEMIBOT_CONFIG_PATH")
    resolved_path = Path(config_path).expanduser() if config_path else default_config_path()
    if not resolved_path.exists():
        return {}
    try:
        with resolved_path.open("rb") as file:
            parsed = tomllib.load(file)
    except Exception:
        return {}
    llm = parsed.get("llm") if isinstance(parsed, dict) else None
    return llm if isinstance(llm, dict) else {}


def _set_env_if_missing(name: str, value: str | None) -> None:
    if not value:
        return
    if os.getenv(name):
        return
    os.environ[name] = value


def _apply_llm_config_to_env(llm_config: dict[str, Any]) -> None:
    if not isinstance(llm_config, dict):
        return

    _set_env_if_missing("CUSTOM_LLM_MODEL_NAME", _as_non_empty_str(llm_config.get("default_model")))

    providers = llm_config.get("providers")
    if not isinstance(providers, dict):
        return

    openai_cfg = providers.get("openai")
    if isinstance(openai_cfg, dict):
        openai_base_url = (
            _as_non_empty_str(openai_cfg.get("base_url"))
            or _as_non_empty_str(openai_cfg.get("baseUrl"))
        )
        _set_env_if_missing("OPENAI_API_BASE_URL", openai_base_url)

    custom_cfg = providers.get("custom")
    if isinstance(custom_cfg, dict):
        custom_base_url = (
            _as_non_empty_str(custom_cfg.get("base_url"))
            or _as_non_empty_str(custom_cfg.get("baseUrl"))
        )
        _set_env_if_missing("CUSTOM_LLM_API_BASE_URL", custom_base_url)


def _control_plane_bootstrap_lock() -> asyncio.Lock:
    global _CONTROL_PLANE_BOOTSTRAP_LOCK
    if _CONTROL_PLANE_BOOTSTRAP_LOCK is None:
        _CONTROL_PLANE_BOOTSTRAP_LOCK = asyncio.Lock()
    return _CONTROL_PLANE_BOOTSTRAP_LOCK


async def _maybe_bootstrap_llm_from_control_plane() -> None:
    global _CONTROL_PLANE_BOOTSTRAP_LAST_ATTEMPT
    if os.getenv("OPENAI_API_KEY") or os.getenv("CUSTOM_LLM_API_KEY"):
        return

    vm_user_id = _as_non_empty_str(os.getenv("VM_USER_ID"))
    vm_token = _as_non_empty_str(os.getenv("VM_TOKEN"))
    if not vm_user_id or not vm_token:
        return

    async with _control_plane_bootstrap_lock():
        if os.getenv("OPENAI_API_KEY") or os.getenv("CUSTOM_LLM_API_KEY"):
            return
        now = time.monotonic()
        if (
            _CONTROL_PLANE_BOOTSTRAP_LAST_ATTEMPT > 0
            and now - _CONTROL_PLANE_BOOTSTRAP_LAST_ATTEMPT < _CONTROL_PLANE_BOOTSTRAP_RETRY_COOLDOWN_SECONDS
        ):
            return
        _CONTROL_PLANE_BOOTSTRAP_LAST_ATTEMPT = now

        control_plane_ws = (
            _as_non_empty_str(os.getenv("CONTROL_PLANE_WS"))
            or DEFAULT_CONTROL_PLANE_WS
        )
        ticket = _as_non_empty_str(os.getenv("VM_TICKET")) or ""
        client = ControlPlaneClient(
            control_plane_url=control_plane_ws,
            user_id=vm_user_id,
            ticket=ticket,
            token=vm_token,
        )

        init_data: dict[str, Any] = {}
        try:
            init_data = await client.connect()
        except Exception as exc:
            logger.warning(
                "control_plane_llm_bootstrap_failed",
                extra={"error": str(exc), "control_plane_ws": control_plane_ws},
            )
            return
        finally:
            try:
                await client.close()
            except Exception:
                pass

        api_keys = decrypt_api_keys(init_data.get("api_keys"), vm_token)
        if isinstance(api_keys, dict):
            _set_env_if_missing("OPENAI_API_KEY", _as_non_empty_str(api_keys.get("openai")))
            _set_env_if_missing("CUSTOM_LLM_API_KEY", _as_non_empty_str(api_keys.get("custom")))

        llm_config = init_data.get("llm_config")
        if isinstance(llm_config, dict):
            _apply_llm_config_to_env(llm_config)

        logger.debug(
            "control_plane_llm_bootstrap_complete",
            extra={
                "has_openai": bool(os.getenv("OPENAI_API_KEY")),
                "has_custom": bool(os.getenv("CUSTOM_LLM_API_KEY")),
            },
        )


def _create_llm_provider(model: str | None = None) -> OpenAIProvider | None:
    llm_config = _load_llm_config()

    openai_key = (
        _as_non_empty_str(os.getenv("OPENAI_API_KEY"))
        or _as_non_empty_str(llm_config.get("openai_api_key"))
    )
    custom_key = (
        _as_non_empty_str(os.getenv("CUSTOM_LLM_API_KEY"))
        or _as_non_empty_str(llm_config.get("custom_api_key"))
    )
    generic_key = _as_non_empty_str(llm_config.get("api_key"))
    api_key = openai_key or custom_key or generic_key
    if not api_key:
        return None

    resolved_model = (
        model
        or _as_non_empty_str(os.getenv("CUSTOM_LLM_MODEL_NAME"))
        or _as_non_empty_str(llm_config.get("default_model"))
        or _as_non_empty_str(llm_config.get("model"))
        or "gpt-4o"
    )

    openai_base_url = (
        _as_non_empty_str(os.getenv("OPENAI_API_BASE_URL"))
        or _as_non_empty_str(llm_config.get("openai_api_base_url"))
        or _as_non_empty_str(llm_config.get("openai_base_url"))
    )
    custom_base_url = (
        _as_non_empty_str(os.getenv("CUSTOM_LLM_API_BASE_URL"))
        or _as_non_empty_str(llm_config.get("custom_api_base_url"))
        or _as_non_empty_str(llm_config.get("custom_base_url"))
    )
    generic_base_url = (
        _as_non_empty_str(llm_config.get("api_base_url"))
        or _as_non_empty_str(llm_config.get("base_url"))
    )
    if openai_key:
        base_url = openai_base_url or generic_base_url or custom_base_url
    elif custom_key:
        base_url = custom_base_url or generic_base_url or openai_base_url
    else:
        base_url = generic_base_url or openai_base_url or custom_base_url

    if base_url and "openai.azure.com" not in base_url and not base_url.rstrip("/").endswith("/v1"):
        base_url = f"{base_url.rstrip('/')}/v1"

    return OpenAIProvider(
        LLMConfig(
            model=resolved_model,
            api_key=api_key,
            base_url=base_url,
            timeout=120,
        )
    )


def _load_tool_configs(db_path: str) -> dict[str, dict[str, Any]]:
    try:
        store = RuntimeConfigStore(db_path=db_path)
        rows = store.list_tools(include_builtin=True, page=1, limit=500).get("data", [])
    except Exception:
        return {}
    configs: dict[str, dict[str, Any]] = {}
    for row in rows:
        if not isinstance(row, dict):
            continue
        name = str(row.get("name") or "").strip()
        if not name:
            continue
        cfg = row.get("config")
        configs[name] = cfg if isinstance(cfg, dict) else {}
    return configs


def _build_tool_definitions(registry: SkillRegistry, db_path: str) -> list[ToolDefinition]:
    tool_configs = _load_tool_configs(db_path)
    tools: list[ToolDefinition] = []
    for tool_name in registry.list_tools():
        tool = registry.get_tool(tool_name)
        if not tool:
            continue
        cfg = tool_configs.get(tool.name, {})
        raw_risk_level = cfg.get("riskLevel")
        if isinstance(raw_risk_level, str) and raw_risk_level.strip():
            risk_level = raw_risk_level.strip().lower()
        elif tool.name in {
            "code_executor",
            "file_io",
            "browser_automation",
            "http_client",
            "csv_xlsx",
            "sql_query_readonly",
        }:
            risk_level = "high"
        else:
            risk_level = "low"
        requires_approval = bool(
            cfg.get(
                "requiresApproval",
                tool.name in {
                    "code_executor",
                    "file_io",
                    "browser_automation",
                    "http_client",
                    "csv_xlsx",
                    "sql_query_readonly",
                },
            )
        )
        raw_approval_scope = str(cfg.get("approvalScope") or "").strip().lower()
        approval_scope = (
            raw_approval_scope
            if raw_approval_scope in _APPROVAL_SCOPE_ALLOWED
            else "session"
        )
        approval_dedupe_keys = _normalize_dedupe_keys(cfg.get("approvalDedupeKeys"))
        tools.append(
            ToolDefinition(
                name=tool.name,
                description=tool.description,
                parameters=tool.parameters,
                metadata={
                    "source": "builtin",
                    "requires_approval": requires_approval,
                    "risk_level": risk_level,
                    "approval_scope": approval_scope,
                    "approval_dedupe_keys": approval_dedupe_keys,
                },
            )
        )
    return tools


def _build_skill_definitions(registry: SkillRegistry) -> list[SkillDefinition]:
    skills: list[SkillDefinition] = []
    for skill_name in registry.list_skills():
        skill = registry.get_skill(skill_name)
        if not skill:
            continue
        skills.append(
            SkillDefinition(
                id=skill_name,
                name=skill_name,
                description=skill.description,
                source="local",
                schema={},
                metadata={},
            )
        )
    return skills


def _extract_final_response(result: dict[str, Any]) -> str:
    messages = result.get("messages")
    if not isinstance(messages, list) or not messages:
        return ""
    last = messages[-1]
    if isinstance(last, dict):
        return str(last.get("content") or "")
    return str(getattr(last, "content", ""))


def _serialize_tool_results(result: dict[str, Any]) -> list[dict[str, Any]]:
    rows = result.get("tool_results")
    if not isinstance(rows, list):
        return []
    serialized: list[dict[str, Any]] = []
    for item in rows:
        if hasattr(item, "model_dump"):
            serialized.append(dict(item.model_dump()))
            continue
        if isinstance(item, dict):
            serialized.append(dict(item))
            continue
        tool_name = getattr(item, "tool_name", None)
        params = getattr(item, "params", None)
        serialized.append(
            {
                "tool_name": str(tool_name or ""),
                "params": dict(params) if isinstance(params, dict) else {},
                "result": getattr(item, "result", None),
                "error": getattr(item, "error", None),
                "duration_ms": int(getattr(item, "duration_ms", 0) or 0),
                "success": bool(getattr(item, "success", False)),
                "metadata": getattr(item, "metadata", {}) or {},
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
    model: str | None = None,
    system_prompt: str | None = None,
) -> dict[str, Any]:
    """Run one user task locally and return execution summary."""
    os.environ["SEMIBOT_EVENTS_DB_PATH"] = db_path
    resolved_session_id = session_id or f"local_{int(time.time() * 1000)}_{uuid4().hex[:8]}"
    runtime_events: list[dict[str, Any]] = []

    async def _runtime_event_sink(event: dict[str, Any]) -> None:
        runtime_events.append(event)

    _maybe_load_local_env_files()
    await _maybe_bootstrap_llm_from_control_plane()

    skill_registry = create_default_registry()
    event_engine = EventEngine(
        store=EventStore(db_path=db_path),
        router=EventRouter(RuntimeActionExecutor(runtime_event_sink=_runtime_event_sink)),
        rules_path=rules_path,
    )
    tool_definitions = _build_tool_definitions(skill_registry, db_path)

    async def _capture_bus_event(event: Event) -> None:
        runtime_events.append(
            {
                "event": event.event_type,
                "source": event.source,
                "subject": event.subject,
                "data": event.payload,
                "risk_hint": event.risk_hint,
                "timestamp": event.timestamp.isoformat(),
            }
        )

    event_engine.bus.subscribe(_capture_bus_event)
    event_engine.reload_rules()
    llm_provider = _create_llm_provider(model)

    high_risk_tools = [
        tool.name
        for tool in tool_definitions
        if bool(tool.metadata.get("requires_approval"))
        or str(tool.metadata.get("risk_level", "")).lower() in {"high", "critical"}
    ]

    async def _approval_hook(
        tool_name: str,
        params: dict[str, Any],
        metadata: Any,
    ) -> dict[str, Any]:
        risk_level = str((metadata.additional or {}).get("risk_level") or "high")
        metadata_additional = metadata.additional if isinstance(metadata.additional, dict) else {}
        scope_session_id = _short_text(
            params.get("session_id") or resolved_session_id,
            max_len=80,
        ) or resolved_session_id
        scope_key, approval_context = _build_approval_policy(
            tool_name,
            params,
            risk_level,
            scope_session_id,
            metadata_additional,
        )

        event_signature = hashlib.sha256(scope_key.encode()).hexdigest()[:16]
        event_id = f"{resolved_session_id}:{event_signature}"

        approved_history = event_engine.store.list_approvals(status="approved", limit=1000)
        for approved in approved_history:
            if approved.event_id == event_id:
                return {
                    "approved": True,
                    "approval_id": approved.approval_id,
                    "reason": "approval already granted",
                    "tool_name": tool_name,
                    "params": params,
                }

        pending_history = event_engine.store.list_approvals(status="pending", limit=1000)
        for pending in pending_history:
            if pending.event_id == event_id:
                return {
                    "approved": False,
                    "approval_id": pending.approval_id,
                    "reason": (
                        f"需要人工审批后才会执行 `{tool_name}`。审批ID: {pending.approval_id}。"
                        f" 可执行 `/approve {pending.approval_id}` 或 `/reject {pending.approval_id}`。"
                    ),
                    "tool_name": tool_name,
                    "params": params,
                }

        approval = await event_engine.approval_manager.request(
            rule_id=f"tool.{tool_name}",
            event_id=event_id,
            risk_level=risk_level,
            context=approval_context,
        )
        return {
            "approved": False,
            "approval_id": approval.approval_id,
            "reason": (
                f"需要人工审批后才会执行 `{tool_name}`。审批ID: {approval.approval_id}。"
                f" 可执行 `/approve {approval.approval_id}` 或 `/reject {approval.approval_id}`。"
            ),
            "tool_name": tool_name,
            "params": params,
        }

    runtime_context = RuntimeSessionContext(
        agent_id=agent_id,
        session_id=resolved_session_id,
        agent_config=AgentConfig(
            id=agent_id,
            name=agent_id,
            system_prompt=system_prompt,
            model=model,
        ),
        metadata={"event_emitter": event_engine},
        available_skills=_build_skill_definitions(skill_registry),
        available_tools=tool_definitions,
        available_mcp_servers=[],
        available_sub_agents=[],
        runtime_policy=RuntimePolicy(
            enable_delegation=False,
            require_approval_for_high_risk=True,
            high_risk_tools=high_risk_tools,
        ),
    )

    unified_executor = UnifiedActionExecutor(
        runtime_context=runtime_context,
        skill_registry=skill_registry,
        mcp_client=None,
        approval_hook=_approval_hook,
        event_emitter=event_engine,
    )

    graph_context: dict[str, Any] = {
        "skill_registry": skill_registry,
        "unified_executor": unified_executor,
    }
    if llm_provider:
        graph_context["llm_provider"] = llm_provider

    graph: Any = create_agent_graph(context=graph_context, runtime_context=runtime_context)
    initial_state = create_initial_state(
        session_id=resolved_session_id,
        agent_id=agent_id,
        user_message=task,
        context=runtime_context,
        metadata={"entrypoint": "cli.run"},
    )

    await event_engine.emit(
        Event(
            event_id=f"evt_{uuid4().hex}",
            event_type="chat.message.received",
            source="cli.run",
            subject=resolved_session_id,
            payload={
                "session_id": resolved_session_id,
                "agent_id": agent_id,
                "message": task,
            },
            risk_hint="low",
            timestamp=datetime.now(UTC),
        )
    )

    try:
        result = await graph.ainvoke(initial_state)
        error = str(result.get("error")) if result.get("error") else None
        status = "failed" if error else "completed"
        final_response = _extract_final_response(result)
        tool_results = _serialize_tool_results(result)

        await event_engine.emit(
            Event(
                event_id=f"evt_{uuid4().hex}",
                event_type="task.completed" if status == "completed" else "task.failed",
                source="cli.run",
                subject=resolved_session_id,
                payload={
                    "session_id": resolved_session_id,
                    "agent_id": agent_id,
                    "status": status,
                    "final_response": final_response,
                    "error": error,
                },
                risk_hint="low" if status == "completed" else "medium",
                timestamp=datetime.now(UTC),
            )
        )

        return {
            "status": status,
            "session_id": resolved_session_id,
            "agent_id": agent_id,
            "final_response": final_response,
            "error": error,
            "tool_results": tool_results,
            "runtime_events": runtime_events,
            "llm_configured": llm_provider is not None,
        }
    except Exception as exc:
        message = str(exc)
        await event_engine.emit(
            Event(
                event_id=f"evt_{uuid4().hex}",
                event_type="task.failed",
                source="cli.run",
                subject=resolved_session_id,
                payload={
                    "session_id": resolved_session_id,
                    "agent_id": agent_id,
                    "status": "failed",
                    "error": message,
                },
                risk_hint="medium",
                timestamp=datetime.now(UTC),
            )
        )
        return {
            "status": "failed",
            "session_id": resolved_session_id,
            "agent_id": agent_id,
            "final_response": "",
            "error": message,
            "tool_results": [],
            "runtime_events": runtime_events,
            "llm_configured": llm_provider is not None,
        }
