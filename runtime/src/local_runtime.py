"""Local one-off runtime execution for Semibot V2 CLI."""

from __future__ import annotations

import asyncio
import json
import os
import re
import time
from collections.abc import Awaitable, Callable
from contextlib import suppress
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from uuid import uuid4

from src.events.event_engine import EventEngine
from src.events.event_router import EventRouter
from src.events.event_store import EventStore
from src.events.models import Event
from src.events.runtime_action_executor import RuntimeActionExecutor
from src.events.runtime_event_persistence import persist_runtime_event_to_store
from src.execution.runtime_approval import (
    build_approval_policy,
    short_text,
)
from src.execution.runtime_components import (
    build_runtime_policy,
    build_runtime_skill_definitions,
    build_runtime_tool_definitions,
)
from src.execution.runtime_execution_core import (
    build_graph_context,
    build_initial_execution_state,
    build_unified_action_executor,
    emit_chat_message_received,
    emit_terminal_runtime_event,
    invoke_graph_once,
)
from src.execution.runtime_llm import (
    as_non_empty_str,
    instantiate_llm_provider,
    provider_base,
    provider_cfg_base_url,
    resolve_model_and_provider_key,
)
from src.execution.runtime_response import guard_rule_authoring_success_claim
from src.execution.runtime_result import normalize_execution_result
from src.execution.runtime_terminal import derive_terminal_execution_result
from src.llm.anthropic_provider import AnthropicProvider
from src.llm.base import LLMProvider
from src.llm.kimi_provider import KimiProvider
from src.llm.openai_provider import OpenAIProvider
from src.llm.provider_factory import (
    MODEL_PROVIDER_HINTS,
    PROVIDER_BASE_URL_ENV_MAP,
    PROVIDER_KEY_ENV_MAP,
    SUPPORTED_PROVIDER_BASES,
)
from src.memory.service import RuntimeMemoryService
from src.orchestrator.context import (
    AgentConfig,
    RuntimeSessionContext,
)
from src.orchestrator.graph import create_agent_graph
from src.orchestrator.unified_executor import UnifiedActionExecutor
from src.security.api_key_cipher import decrypt_api_keys
from src.server.config_store import RuntimeConfigStore
from src.session.workspace import session_working_dir as _shared_session_working_dir
from src.skills.bootstrap import create_default_registry
from src.skills.registry import SkillRegistry
from src.utils.logging import get_logger
from src.ws.client import ControlPlaneClient
from src.ws.event_emitter import EventEmitter

DEFAULT_CONTROL_PLANE_WS = "ws://127.0.0.1:3001/ws/vm"
logger = get_logger(__name__)

_CONTROL_PLANE_BOOTSTRAP_LOCK: asyncio.Lock | None = None
_CONTROL_PLANE_BOOTSTRAP_LAST_ATTEMPT = 0.0
_CONTROL_PLANE_BOOTSTRAP_RETRY_COOLDOWN_SECONDS = 15.0
_LOCAL_ENV_BOOTSTRAP_DONE = False

_ENV_KEY_PATTERN = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
_OPENAI_COMPATIBLE_PROVIDER_BASES = SUPPORTED_PROVIDER_BASES
_MODEL_PROVIDER_HINTS = MODEL_PROVIDER_HINTS
_PROVIDER_KEY_ENV_MAP = PROVIDER_KEY_ENV_MAP
_PROVIDER_BASE_URL_ENV_MAP = PROVIDER_BASE_URL_ENV_MAP


def _build_tool_definitions(registry: SkillRegistry, db_path: str) -> list[Any]:
    return build_runtime_tool_definitions(registry, db_path)


def _build_skill_definitions(
    registry: SkillRegistry,
    skill_index: list[dict[str, Any]] | None = None,
) -> list[Any]:
    return build_runtime_skill_definitions(registry, skill_index)


def _short_text(value: Any, *, max_len: int = 120) -> str:
    return short_text(value, max_len=max_len)


def _as_non_empty_str(value: Any) -> str | None:
    return as_non_empty_str(value)


def _provider_base(provider_key: str) -> str:
    return provider_base(provider_key)


def _provider_cfg_base_url(raw_cfg: Any) -> str | None:
    return provider_cfg_base_url(raw_cfg)


def _build_approval_policy(
    tool_name: str,
    params: dict[str, Any],
    risk_level: str,
    session_id: str,
    metadata_additional: dict[str, Any] | None = None,
) -> tuple[str, dict[str, Any]]:
    return build_approval_policy(
        tool_name,
        params,
        risk_level,
        session_id,
        metadata_additional,
    )


def _runtime_root() -> Path:
    return Path(__file__).resolve().parents[1]


def _session_working_dir(session_id: str) -> Path:
    return _shared_session_working_dir(session_id)


def _session_memory_dir(session_id: str) -> Path:
    return Path(".semibot/sessions") / session_id / "memory"


def _repo_root() -> Path:
    return Path(__file__).resolve().parents[2]


def _parse_env_value(raw: str) -> str:
    value = raw.strip()
    if not value:
        return ""
    if " #" in value:
        value = value.split(" #", maxsplit=1)[0].strip()
    if (value.startswith('"') and value.endswith('"')) or (value.startswith("'") and value.endswith("'")):
        inner = value[1:-1]
        try:
            return bytes(inner, "utf-8").decode("unicode_escape")
        except Exception:
            return inner
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
    # LLM routing/model config must not be sourced from config.toml.
    # Runtime LLM selection is driven by runtime sqlite config, env vars,
    # and optional control-plane payloads.
    db_path = (
        _as_non_empty_str(os.getenv("SEMIBOT_EVENTS_DB_PATH"))
        or _as_non_empty_str(os.getenv("SEMIBOT_RUNTIME_DB_PATH"))
        or str(Path("~/.semibot/semibot.db").expanduser())
    )
    try:
        store = RuntimeConfigStore(db_path=db_path)
        config = store.get_llm_settings()
        return config if isinstance(config, dict) else {}
    except Exception:
        return {}


def _load_env_provider_instances() -> dict[str, dict[str, Any]]:
    raw = _as_non_empty_str(os.getenv("LLM_PROVIDER_INSTANCES"))
    if not raw:
        return {}
    try:
        payload = json.loads(raw)
    except Exception:
        return {}
    if not isinstance(payload, list):
        return {}

    providers: dict[str, dict[str, Any]] = {}
    for row in payload:
        if not isinstance(row, dict):
            continue
        provider_type = _as_non_empty_str(row.get("type"))
        instance_id = _as_non_empty_str(row.get("id"))
        if not provider_type or not instance_id:
            continue
        entry: dict[str, Any] = {}
        api_key = _as_non_empty_str(row.get("api_key") or row.get("apiKey"))
        base_url = _as_non_empty_str(row.get("base_url") or row.get("baseUrl"))
        if api_key:
            entry["api_key"] = api_key
        if base_url:
            entry["base_url"] = base_url
        providers[f"{provider_type}:{instance_id}"] = entry
    return providers


def _control_plane_bootstrap_lock() -> asyncio.Lock:
    global _CONTROL_PLANE_BOOTSTRAP_LOCK
    if _CONTROL_PLANE_BOOTSTRAP_LOCK is None:
        _CONTROL_PLANE_BOOTSTRAP_LOCK = asyncio.Lock()
    return _CONTROL_PLANE_BOOTSTRAP_LOCK


async def _maybe_bootstrap_llm_from_control_plane() -> None:
    global _CONTROL_PLANE_BOOTSTRAP_LAST_ATTEMPT

    has_env_compat = bool(
        _as_non_empty_str(os.getenv("OPENAI_API_KEY"))
        or _as_non_empty_str(os.getenv("CUSTOM_LLM_API_KEY"))
        or _as_non_empty_str(os.getenv("CUSTOM_LLM_MODEL_NAME"))
        or _as_non_empty_str(os.getenv("OPENAI_API_BASE_URL"))
        or _as_non_empty_str(os.getenv("CUSTOM_LLM_API_BASE_URL"))
    )

    # Check if DB already has LLM config
    llm_config = _load_llm_config()
    has_local_config = bool(
        _as_non_empty_str(llm_config.get("default_model"))
        or _as_non_empty_str(llm_config.get("default_provider_key"))
        or (isinstance(llm_config.get("providers"), dict) and llm_config["providers"])
    )
    if has_local_config and has_env_compat:
        return

    vm_user_id = _as_non_empty_str(os.getenv("VM_USER_ID"))
    vm_token = _as_non_empty_str(os.getenv("VM_TOKEN"))
    if not vm_user_id or not vm_token:
        return

    async with _control_plane_bootstrap_lock():
        # Re-check after acquiring lock
        llm_config = _load_llm_config()
        has_local_config = bool(
            _as_non_empty_str(llm_config.get("default_model"))
            or _as_non_empty_str(llm_config.get("default_provider_key"))
            or (isinstance(llm_config.get("providers"), dict) and llm_config["providers"])
        )
        has_env_compat = bool(
            _as_non_empty_str(os.getenv("OPENAI_API_KEY"))
            or _as_non_empty_str(os.getenv("CUSTOM_LLM_API_KEY"))
            or _as_non_empty_str(os.getenv("CUSTOM_LLM_MODEL_NAME"))
            or _as_non_empty_str(os.getenv("OPENAI_API_BASE_URL"))
            or _as_non_empty_str(os.getenv("CUSTOM_LLM_API_BASE_URL"))
        )
        if has_local_config and has_env_compat:
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
            with suppress(Exception):
                await client.close()

        api_keys = decrypt_api_keys(init_data.get("api_keys"), vm_token)
        remote_llm_config = init_data.get("llm_config")

        # Build providers dict from api_keys
        providers: dict[str, dict[str, Any]] = {}
        if isinstance(api_keys, dict):
            for provider_key, api_key in api_keys.items():
                key = str(provider_key or "").strip()
                val = _as_non_empty_str(api_key)
                if not key or not val:
                    continue
                providers[key] = {"api_key": val}

        # Merge base_urls from remote llm_config
        if isinstance(remote_llm_config, dict):
            remote_providers = remote_llm_config.get("providers")
            if isinstance(remote_providers, dict):
                for pk, cfg in remote_providers.items():
                    if pk not in providers:
                        providers[pk] = {}
                    if isinstance(cfg, dict):
                        base_url = _provider_cfg_base_url(cfg)
                        if base_url:
                            providers[pk]["base_url"] = base_url

        payload: dict[str, Any] = {"providers": providers}
        if isinstance(remote_llm_config, dict):
            for field in ("default_model", "default_provider_key", "fallback_model", "fallback_provider_key"):
                val = _as_non_empty_str(remote_llm_config.get(field))
                if val:
                    payload[field] = val

        default_model = _as_non_empty_str(payload.get("default_model"))
        openai_provider_cfg = providers.get("openai") if isinstance(providers.get("openai"), dict) else {}
        openai_api_key = _as_non_empty_str(openai_provider_cfg.get("api_key"))
        openai_base_url = _provider_cfg_base_url(openai_provider_cfg)
        if openai_api_key:
            os.environ["OPENAI_API_KEY"] = openai_api_key
        if default_model:
            os.environ["CUSTOM_LLM_MODEL_NAME"] = default_model
        if openai_base_url:
            os.environ["OPENAI_API_BASE_URL"] = openai_base_url

        if providers or payload.get("default_model"):
            db_path = (
                _as_non_empty_str(os.getenv("SEMIBOT_EVENTS_DB_PATH"))
                or _as_non_empty_str(os.getenv("SEMIBOT_RUNTIME_DB_PATH"))
                or str(Path("~/.semibot/semibot.db").expanduser())
            )
            try:
                store = RuntimeConfigStore(db_path=db_path)
                store.update_llm_settings(payload)
                logger.debug(
                    "control_plane_llm_bootstrap_complete",
                    extra={"providers": list(providers.keys())},
                )
            except Exception as exc:
                logger.warning(
                    "control_plane_llm_bootstrap_db_write_failed",
                    extra={"error": str(exc)},
                )


def _create_llm_provider(
    model: str | None = None,
    *,
    model_provider_key: str | None = None,
    fallback_model: str | None = None,
    fallback_provider_key: str | None = None,
) -> LLMProvider | None:
    llm_config = _load_llm_config()
    env_default_model = _as_non_empty_str(os.getenv("DEFAULT_LLM_MODEL"))
    env_fallback_model = _as_non_empty_str(os.getenv("FALLBACK_LLM_MODEL"))
    env_custom_model = _as_non_empty_str(os.getenv("CUSTOM_LLM_MODEL_NAME"))

    default_model = (
        _as_non_empty_str(llm_config.get("default_model"))
        or _as_non_empty_str(llm_config.get("model"))
        or env_default_model
        or env_custom_model
    )
    configured_fallback_model = (
        _as_non_empty_str(fallback_model)
        or _as_non_empty_str(llm_config.get("fallback_model"))
        or env_fallback_model
    )
    default_provider_key = (
        _as_non_empty_str(model_provider_key)
        or _as_non_empty_str(llm_config.get("default_provider_key"))
    )
    resolved_model = (
        model
        or default_model
        or configured_fallback_model
    )

    api_keys: dict[str, str] = {}
    instance_base_urls: dict[str, str] = {}

    providers_cfg = llm_config.get("providers")
    if isinstance(providers_cfg, dict):
        for provider_key, raw_cfg in providers_cfg.items():
            key = _as_non_empty_str(provider_key)
            if not key or not isinstance(raw_cfg, dict):
                continue
            api_key = _as_non_empty_str(raw_cfg.get("api_key") or raw_cfg.get("apiKey"))
            if api_key:
                api_keys[key] = api_key
            base_url = _provider_cfg_base_url(raw_cfg)
            if base_url:
                instance_base_urls[key] = base_url

    for provider_key, raw_cfg in _load_env_provider_instances().items():
        api_key = _as_non_empty_str(raw_cfg.get("api_key"))
        if api_key:
            api_keys[provider_key] = api_key
        base_url = _provider_cfg_base_url(raw_cfg)
        if base_url:
            instance_base_urls[provider_key] = base_url

    if not api_keys:
        openai_cfg_key = (
            _as_non_empty_str(llm_config.get("openai_api_key"))
            or _as_non_empty_str(os.getenv("OPENAI_API_KEY"))
        )
        if openai_cfg_key:
            api_keys["openai"] = openai_cfg_key
        custom_cfg_key = (
            _as_non_empty_str(llm_config.get("custom_api_key"))
            or _as_non_empty_str(os.getenv("CUSTOM_LLM_API_KEY"))
        )
        if custom_cfg_key:
            api_keys["custom"] = custom_cfg_key
        generic_key = (
            _as_non_empty_str(llm_config.get("api_key"))
            or _as_non_empty_str(os.getenv("API_KEY"))
        )
        if generic_key:
            api_keys["custom"] = generic_key

    requested_model = _as_non_empty_str(model) or resolved_model
    resolved_model, selected_provider_key, used_default_model_fallback = resolve_model_and_provider_key(
        requested_model=requested_model,
        default_model=default_model,
        default_provider_key=default_provider_key,
        api_keys=api_keys,
        compatible_provider_bases=set(_OPENAI_COMPATIBLE_PROVIDER_BASES),
    )
    if used_default_model_fallback and default_model and requested_model:
        logger.warning(
            "local_runtime_model_fallback_to_default_model",
            extra={
                "explicit_model": requested_model,
                "default_model": default_model,
                "fallback_provider_key": selected_provider_key,
            },
        )
    if not selected_provider_key:
        return None

    api_key = api_keys.get(selected_provider_key)
    if not api_key:
        return None

    provider_base = _provider_base(selected_provider_key)

    base_url: str | None = instance_base_urls.get(selected_provider_key)
    if isinstance(providers_cfg, dict):
        if not base_url:
            base_url = _provider_cfg_base_url(providers_cfg.get(selected_provider_key))
        if not base_url:
            base_url = _provider_cfg_base_url(providers_cfg.get(provider_base))

    if not base_url:
        if provider_base == "openai":
            base_url = (
                _as_non_empty_str(llm_config.get("openai_api_base_url"))
                or _as_non_empty_str(llm_config.get("openai_base_url"))
                or _as_non_empty_str(os.getenv("OPENAI_API_BASE_URL"))
            )
        elif provider_base == "custom":
            base_url = (
                _as_non_empty_str(llm_config.get("custom_api_base_url"))
                or _as_non_empty_str(llm_config.get("custom_base_url"))
                or _as_non_empty_str(os.getenv("CUSTOM_LLM_API_BASE_URL"))
            )
        else:
            base_url = (
                _as_non_empty_str(llm_config.get(f"{provider_base}_api_base_url"))
                or _as_non_empty_str(llm_config.get(f"{provider_base}_base_url"))
                or _as_non_empty_str(os.getenv(f"{provider_base.upper()}_API_BASE_URL"))
            )
    if not base_url:
        base_url = (
            _as_non_empty_str(llm_config.get("api_base_url"))
            or _as_non_empty_str(llm_config.get("base_url"))
        )

    if base_url and "openai.azure.com" not in base_url and not base_url.rstrip("/").endswith("/v1"):
        base_url = f"{base_url.rstrip('/')}/v1"

    logger.info(
        "local_runtime_llm_provider_selected",
        extra={"model": resolved_model, "provider_key": selected_provider_key, "provider_base": provider_base},
    )

    return instantiate_llm_provider(
        model=resolved_model,
        api_key=api_key,
        provider_key=selected_provider_key,
        base_url=base_url,
        timeout=120,
        openai_provider_cls=OpenAIProvider,
        kimi_provider_cls=KimiProvider,
        anthropic_provider_cls=AnthropicProvider,
    )


def _guard_rule_authoring_success_claim(final_response: str, tool_results: list[dict[str, Any]]) -> str:
    return guard_rule_authoring_success_claim(final_response, tool_results)



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
    recent_tool_usage: dict[str, int] | None = None,
    runtime_event_callback: Callable[[dict[str, Any]], Awaitable[None]] | None = None,
) -> dict[str, Any]:
    """Run one user task locally and return execution summary."""
    os.environ["SEMIBOT_EVENTS_DB_PATH"] = db_path
    os.environ["SEMIBOT_RULES_PATH"] = rules_path
    resolved_session_id = session_id or f"local_{int(time.time() * 1000)}_{uuid4().hex[:8]}"
    resolved_approval_scope_id = (
        _short_text(approval_scope_id, max_len=80) if isinstance(approval_scope_id, str) else ""
    ) or resolved_session_id
    runtime_events: list[dict[str, Any]] = []

    async def _runtime_event_sink(event: dict[str, Any]) -> None:
        runtime_events.append(event)
        if runtime_event_callback:
            with suppress(Exception):
                await runtime_event_callback(event)

    _maybe_load_local_env_files()
    await _maybe_bootstrap_llm_from_control_plane()

    skill_registry = create_default_registry()
    event_engine = EventEngine(
        store=EventStore(db_path=db_path),
        router=EventRouter(RuntimeActionExecutor(runtime_event_sink=_runtime_event_sink)),
        rules_path=rules_path,
    )
    tool_definitions = build_runtime_tool_definitions(skill_registry, db_path)

    async def _capture_bus_event(event: Event) -> None:
        payload = {
            "event": event.event_type,
            "source": event.source,
            "subject": event.subject,
            "data": event.payload,
            "risk_hint": event.risk_hint,
            "timestamp": event.timestamp.isoformat(),
        }
        runtime_events.append(payload)
        if runtime_event_callback:
            with suppress(Exception):
                await runtime_event_callback(payload)

    event_engine.bus.subscribe(_capture_bus_event)
    event_engine.reload_rules()
    llm_provider = _create_llm_provider(
        model,
        model_provider_key=model_provider_key,
        fallback_model=fallback_model,
        fallback_provider_key=fallback_provider_key,
    )

    resolved_skill_index: list[dict[str, Any]] = []
    if isinstance(skill_index, list):
        resolved_skill_index = [row for row in skill_index if isinstance(row, dict)]

    runtime_context = RuntimeSessionContext(
        agent_id=agent_id,
        session_id=resolved_session_id,
        agent_config=AgentConfig(
            id=agent_id,
            name=agent_id,
            system_prompt=system_prompt,
            model=model,
        ),
        metadata={
            "event_emitter": event_engine,
            "skill_registry": skill_registry,
            "skill_index": resolved_skill_index,
            "llm_provider": llm_provider,
            "recent_tool_usage": dict(recent_tool_usage or {}),
            "session_working_dir": str(_session_working_dir(resolved_session_id)),
        },
        available_skills=build_runtime_skill_definitions(skill_registry, resolved_skill_index),
        available_tools=tool_definitions,
        available_mcp_servers=[],
        available_sub_agents=[],
        runtime_policy=build_runtime_policy(
            tool_definitions,
            enable_delegation=False,
        ),
    )

    unified_executor = build_unified_action_executor(
        runtime_context=runtime_context,
        skill_registry=skill_registry,
        event_engine=event_engine,
        default_session_id=resolved_session_id,
        approval_scope_id=resolved_approval_scope_id,
        mcp_client=None,
        executor_cls=UnifiedActionExecutor,
    )

    runtime_event_emitter = EventEmitter()

    memory_service = RuntimeMemoryService(
        client=None,
        base_dir=str(_session_memory_dir(resolved_session_id)),
        llm_provider=llm_provider,
        act_model=(runtime_context.agent_config.model_roles.act.model or runtime_context.agent_config.model) if runtime_context and runtime_context.agent_config else None,
        bound_session_id=resolved_session_id,
        event_emitter=runtime_event_emitter,
    )
    runtime_context.metadata["memory_service"] = memory_service

    async def _drain_runtime_events() -> None:
        async for event in runtime_event_emitter:
            await _runtime_event_sink(event)
            persist_runtime_event_to_store(event_engine, event)

    drain_task = asyncio.create_task(_drain_runtime_events())

    graph_context = build_graph_context(
        skill_registry=skill_registry,
        unified_executor=unified_executor,
        emitter=runtime_event_emitter,
        memory_system=memory_service,
        llm_provider=llm_provider,
    )

    graph: Any = create_agent_graph(context=graph_context, runtime_context=runtime_context)
    initial_state = build_initial_execution_state(
        session_id=resolved_session_id,
        agent_id=agent_id,
        user_message=task,
        runtime_context=runtime_context,
        metadata={"entrypoint": "cli.run"},
    )

    await emit_chat_message_received(
        event_engine,
        source="cli.run",
        session_id=resolved_session_id,
        agent_id=agent_id,
        message=task,
    )

    try:
        result = await invoke_graph_once(graph, initial_state)
        normalized_result = normalize_execution_result(result, runtime_events=runtime_events)
        normalized_result.final_response = guard_rule_authoring_success_claim(
            normalized_result.final_response,
            normalized_result.tool_results,
        )
        terminal_result = derive_terminal_execution_result(normalized_result)

        await emit_terminal_runtime_event(
            event_engine,
            source="cli.run",
            session_id=resolved_session_id,
            agent_id=agent_id,
            terminal_result=terminal_result,
        )

        return {
            "status": terminal_result.status,
            "session_id": resolved_session_id,
            "agent_id": agent_id,
            "final_response": terminal_result.final_response,
            "awaiting_approval_message": terminal_result.awaiting_approval_message,
            "error": terminal_result.error,
            "tool_results": normalized_result.tool_results,
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
    finally:
        with suppress(Exception):
            await runtime_event_emitter.close()
        with suppress(Exception):
            await drain_task
