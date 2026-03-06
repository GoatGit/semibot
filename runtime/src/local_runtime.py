"""Local one-off runtime execution for Semibot V2 CLI."""

from __future__ import annotations

import asyncio
from contextlib import suppress
import hashlib
import json
import os
import re
import time
from datetime import UTC, datetime
from pathlib import Path
from collections.abc import Awaitable, Callable
from typing import Any
from uuid import uuid4

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
from src.ws.event_emitter import EventEmitter

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
_OPENAI_COMPATIBLE_PROVIDER_BASES = ("openai", "kimi", "qwen", "minimax", "xai", "custom")
_MODEL_PROVIDER_HINTS: dict[str, tuple[str, ...]] = {
    "kimi": ("kimi", "moonshot", "k1", "k2"),
    "qwen": ("qwen", "qwq"),
    "minimax": ("minimax", "abab", "m1", "m2"),
    "xai": ("grok", "xai"),
    "openai": ("gpt", "o1", "o3", "o4", "chatgpt"),
}
_PROVIDER_KEY_ENV_MAP: dict[str, str] = {
    "openai": "OPENAI_API_KEY",
    "kimi": "KIMI_API_KEY",
    "qwen": "QWEN_API_KEY",
    "minimax": "MINIMAX_API_KEY",
    "xai": "XAI_API_KEY",
    "custom": "CUSTOM_LLM_API_KEY",
}
_PROVIDER_BASE_URL_ENV_MAP: dict[str, str] = {
    "openai": "OPENAI_API_BASE_URL",
    "kimi": "KIMI_API_BASE_URL",
    "qwen": "QWEN_API_BASE_URL",
    "minimax": "MINIMAX_API_BASE_URL",
    "xai": "XAI_API_BASE_URL",
    "custom": "CUSTOM_LLM_API_BASE_URL",
}


def _as_non_empty_str(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    trimmed = value.strip()
    return trimmed or None


def _provider_base(provider_key: str) -> str:
    return str(provider_key or "").strip().lower().split(":", 1)[0]


def _provider_cfg_base_url(raw_cfg: Any) -> str | None:
    if not isinstance(raw_cfg, dict):
        return None
    base_url = raw_cfg.get("base_url") or raw_cfg.get("baseUrl")
    if not isinstance(base_url, str):
        return None
    trimmed = base_url.strip()
    return trimmed or None


def _infer_openai_compatible_provider_base(model: str) -> str | None:
    model_lower = str(model or "").strip().lower()
    if not model_lower:
        return None
    for base in ("kimi", "qwen", "minimax", "xai", "openai"):
        hints = _MODEL_PROVIDER_HINTS.get(base, ())
        if hints and any(token in model_lower for token in hints):
            return base
    return None


def _pick_openai_compatible_provider_key(
    model: str,
    api_keys: dict[str, str],
    *,
    strict_preferred_base: bool = False,
) -> str | None:
    candidates = [
        key
        for key, value in api_keys.items()
        if value and _provider_base(key) in _OPENAI_COMPATIBLE_PROVIDER_BASES
    ]
    if not candidates:
        return None

    preferred_base = _infer_openai_compatible_provider_base(model)
    if preferred_base:
        if preferred_base in api_keys and api_keys.get(preferred_base):
            return preferred_base
        scoped = sorted(key for key in candidates if key.startswith(f"{preferred_base}:"))
        if scoped:
            return scoped[0]
        if strict_preferred_base:
            return None

    for base in _OPENAI_COMPATIBLE_PROVIDER_BASES:
        if base in api_keys and api_keys.get(base):
            return base
        scoped = sorted(key for key in candidates if key.startswith(f"{base}:"))
        if scoped:
            return scoped[0]

    return sorted(candidates)[0]


def _to_bool(value: Any, default: bool = False) -> bool:
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value != 0
    if isinstance(value, str):
        normalized = value.strip().lower()
        if normalized in {"1", "true", "yes", "y", "on"}:
            return True
        if normalized in {"0", "false", "no", "n", "off", ""}:
            return False
    return bool(value)


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
    # Runtime LLM selection is driven by env vars and control-plane payloads only.
    return {}


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
    _set_env_if_missing("DEFAULT_LLM_PROVIDER_KEY", _as_non_empty_str(llm_config.get("default_provider_key")))
    _set_env_if_missing("FALLBACK_LLM_PROVIDER_KEY", _as_non_empty_str(llm_config.get("fallback_provider_key")))

    providers = llm_config.get("providers")
    if not isinstance(providers, dict):
        return

    for provider_key, raw_cfg in providers.items():
        base = _provider_base(str(provider_key))
        env_name = _PROVIDER_BASE_URL_ENV_MAP.get(base)
        if not env_name:
            continue
        _set_env_if_missing(env_name, _provider_cfg_base_url(raw_cfg))


def _set_instance_provider_env(
    *,
    api_keys: dict[str, Any],
    llm_config: dict[str, Any] | None,
) -> None:
    instances: list[dict[str, str]] = []
    providers_cfg = llm_config.get("providers") if isinstance(llm_config, dict) else {}
    for provider_key, raw_value in api_keys.items():
        key = str(provider_key or "").strip()
        if ":" not in key:
            continue
        provider_type, provider_id = key.split(":", 1)
        provider_type = provider_type.strip().lower()
        provider_id = provider_id.strip()
        api_key = _as_non_empty_str(raw_value)
        if not provider_type or not provider_id or not api_key:
            continue
        base_url = None
        if isinstance(providers_cfg, dict):
            base_url = _provider_cfg_base_url(providers_cfg.get(key))
        instance = {
            "type": provider_type,
            "id": provider_id,
            "apiKey": api_key,
        }
        if base_url:
            instance["baseUrl"] = base_url
        instances.append(instance)

    if not instances:
        return

    existing_raw = _as_non_empty_str(os.getenv("LLM_PROVIDER_INSTANCES"))
    existing: list[dict[str, Any]] = []
    if existing_raw:
        try:
            parsed = json.loads(existing_raw)
            if isinstance(parsed, list):
                existing = [item for item in parsed if isinstance(item, dict)]
        except Exception:
            existing = []

    merged: dict[tuple[str, str], dict[str, Any]] = {}
    for item in existing:
        provider_type = str(item.get("type") or "").strip().lower()
        provider_id = str(item.get("id") or "").strip()
        if provider_type and provider_id:
            merged[(provider_type, provider_id)] = item
    for item in instances:
        merged[(item["type"], item["id"])] = item

    if not os.getenv("LLM_PROVIDER_INSTANCES"):
        os.environ["LLM_PROVIDER_INSTANCES"] = json.dumps(
            list(merged.values()),
            ensure_ascii=False,
        )


def _control_plane_bootstrap_lock() -> asyncio.Lock:
    global _CONTROL_PLANE_BOOTSTRAP_LOCK
    if _CONTROL_PLANE_BOOTSTRAP_LOCK is None:
        _CONTROL_PLANE_BOOTSTRAP_LOCK = asyncio.Lock()
    return _CONTROL_PLANE_BOOTSTRAP_LOCK


async def _maybe_bootstrap_llm_from_control_plane() -> None:
    global _CONTROL_PLANE_BOOTSTRAP_LAST_ATTEMPT
    has_local_key = any(
        _as_non_empty_str(os.getenv(env_name))
        for env_name in _PROVIDER_KEY_ENV_MAP.values()
    )
    if has_local_key:
        return

    vm_user_id = _as_non_empty_str(os.getenv("VM_USER_ID"))
    vm_token = _as_non_empty_str(os.getenv("VM_TOKEN"))
    if not vm_user_id or not vm_token:
        return

    async with _control_plane_bootstrap_lock():
        has_local_key = any(
            _as_non_empty_str(os.getenv(env_name))
            for env_name in _PROVIDER_KEY_ENV_MAP.values()
        )
        if has_local_key:
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
            for provider_base, env_name in _PROVIDER_KEY_ENV_MAP.items():
                _set_env_if_missing(env_name, _as_non_empty_str(api_keys.get(provider_base)))

        llm_config = init_data.get("llm_config")
        if isinstance(llm_config, dict):
            _apply_llm_config_to_env(llm_config)
        if isinstance(api_keys, dict):
            _set_instance_provider_env(api_keys=api_keys, llm_config=llm_config if isinstance(llm_config, dict) else None)

        logger.debug(
            "control_plane_llm_bootstrap_complete",
            extra={
                "has_openai": bool(os.getenv("OPENAI_API_KEY")),
                "has_kimi": bool(os.getenv("KIMI_API_KEY")),
                "has_qwen": bool(os.getenv("QWEN_API_KEY")),
                "has_minimax": bool(os.getenv("MINIMAX_API_KEY")),
                "has_xai": bool(os.getenv("XAI_API_KEY")),
                "has_custom": bool(os.getenv("CUSTOM_LLM_API_KEY")),
            },
        )


def _create_llm_provider(
    model: str | None = None,
    *,
    model_provider_key: str | None = None,
    fallback_model: str | None = None,
    fallback_provider_key: str | None = None,
) -> OpenAIProvider | None:
    llm_config = _load_llm_config()

    default_model = (
        _as_non_empty_str(os.getenv("DEFAULT_LLM_MODEL"))
        or
        _as_non_empty_str(llm_config.get("default_model"))
        or _as_non_empty_str(llm_config.get("model"))
    )
    configured_fallback_model = (
        _as_non_empty_str(fallback_model)
        or _as_non_empty_str(os.getenv("FALLBACK_LLM_MODEL"))
        or _as_non_empty_str(llm_config.get("fallback_model"))
    )
    default_provider_key = (
        _as_non_empty_str(model_provider_key)
        or _as_non_empty_str(os.getenv("DEFAULT_LLM_PROVIDER_KEY"))
        or _as_non_empty_str(llm_config.get("default_provider_key"))
    )
    configured_fallback_provider_key = (
        _as_non_empty_str(fallback_provider_key)
        or _as_non_empty_str(os.getenv("FALLBACK_LLM_PROVIDER_KEY"))
        or _as_non_empty_str(llm_config.get("fallback_provider_key"))
    )
    resolved_model = (
        model
        or _as_non_empty_str(os.getenv("CUSTOM_LLM_MODEL_NAME"))
        or default_model
        or configured_fallback_model
    )

    api_keys: dict[str, str] = {}
    instance_base_urls: dict[str, str] = {}
    for provider_base, env_name in _PROVIDER_KEY_ENV_MAP.items():
        env_key = _as_non_empty_str(os.getenv(env_name))
        if env_key:
            api_keys[provider_base] = env_key

    raw_instances = _as_non_empty_str(os.getenv("LLM_PROVIDER_INSTANCES"))
    if raw_instances:
        try:
            parsed_instances = json.loads(raw_instances)
        except Exception:
            parsed_instances = []
        if isinstance(parsed_instances, list):
            for item in parsed_instances:
                if not isinstance(item, dict):
                    continue
                provider_type = _provider_base(str(item.get("type") or ""))
                provider_id = str(item.get("id") or "").strip()
                if not provider_id or provider_type not in _OPENAI_COMPATIBLE_PROVIDER_BASES:
                    continue
                provider_key = f"{provider_type}:{provider_id}"
                instance_key = _as_non_empty_str(item.get("apiKey"))
                if instance_key:
                    api_keys[provider_key] = instance_key
                instance_base_url = _as_non_empty_str(item.get("baseUrl"))
                if instance_base_url:
                    instance_base_urls[provider_key] = instance_base_url

    legacy_custom_instances = _as_non_empty_str(os.getenv("CUSTOM_LLM_PROVIDERS"))
    if legacy_custom_instances:
        try:
            parsed_legacy = json.loads(legacy_custom_instances)
        except Exception:
            parsed_legacy = []
        if isinstance(parsed_legacy, list):
            for item in parsed_legacy:
                if not isinstance(item, dict):
                    continue
                provider_id = str(item.get("id") or "").strip()
                if not provider_id:
                    continue
                provider_key = f"custom:{provider_id}"
                instance_key = _as_non_empty_str(item.get("apiKey"))
                if instance_key:
                    api_keys[provider_key] = instance_key
                instance_base_url = _as_non_empty_str(item.get("baseUrl"))
                if instance_base_url:
                    instance_base_urls[provider_key] = instance_base_url

    if not api_keys:
        openai_cfg_key = _as_non_empty_str(llm_config.get("openai_api_key"))
        if openai_cfg_key:
            api_keys["openai"] = openai_cfg_key
        custom_cfg_key = _as_non_empty_str(llm_config.get("custom_api_key"))
        if custom_cfg_key:
            api_keys["custom"] = custom_cfg_key
        generic_key = _as_non_empty_str(llm_config.get("api_key"))
        if generic_key:
            api_keys["custom"] = generic_key

    selected_provider_key = None
    if default_model and str(resolved_model).strip() == str(default_model).strip():
        if default_provider_key and api_keys.get(default_provider_key):
            selected_provider_key = default_provider_key
    if configured_fallback_model and str(resolved_model).strip() == str(configured_fallback_model).strip():
        if configured_fallback_provider_key and api_keys.get(configured_fallback_provider_key):
            selected_provider_key = configured_fallback_provider_key
    if not selected_provider_key:
        selected_provider_key = _pick_openai_compatible_provider_key(str(resolved_model), api_keys)
    explicit_model = _as_non_empty_str(model)
    if explicit_model:
        strict_provider_for_explicit_model = _pick_openai_compatible_provider_key(
            explicit_model,
            api_keys,
            strict_preferred_base=True,
        )
        if strict_provider_for_explicit_model is None and default_model:
            default_provider = (
                default_provider_key
                if default_provider_key and api_keys.get(default_provider_key)
                else _pick_openai_compatible_provider_key(default_model, api_keys)
            )
            if default_provider:
                logger.warning(
                    "local_runtime_model_fallback_to_default_model",
                    extra={
                        "explicit_model": explicit_model,
                        "default_model": default_model,
                        "fallback_provider_key": default_provider,
                    },
                )
                resolved_model = default_model
                selected_provider_key = default_provider
    if not selected_provider_key:
        return None

    api_key = api_keys.get(selected_provider_key)
    if not api_key:
        return None

    provider_base = _provider_base(selected_provider_key)

    base_url: str | None = instance_base_urls.get(selected_provider_key)
    providers_cfg = llm_config.get("providers")
    if isinstance(providers_cfg, dict):
        if not base_url:
            base_url = _provider_cfg_base_url(providers_cfg.get(selected_provider_key))
        if not base_url:
            base_url = _provider_cfg_base_url(providers_cfg.get(provider_base))

    if not base_url:
        env_base_name = _PROVIDER_BASE_URL_ENV_MAP.get(provider_base)
        if env_base_name:
            base_url = _as_non_empty_str(os.getenv(env_base_name))

    if not base_url:
        if provider_base == "openai":
            base_url = (
                _as_non_empty_str(llm_config.get("openai_api_base_url"))
                or _as_non_empty_str(llm_config.get("openai_base_url"))
            )
        elif provider_base == "custom":
            base_url = (
                _as_non_empty_str(llm_config.get("custom_api_base_url"))
                or _as_non_empty_str(llm_config.get("custom_base_url"))
            )
        else:
            base_url = (
                _as_non_empty_str(llm_config.get(f"{provider_base}_api_base_url"))
                or _as_non_empty_str(llm_config.get(f"{provider_base}_base_url"))
            )
    if not base_url:
        base_url = (
            _as_non_empty_str(llm_config.get("api_base_url"))
            or _as_non_empty_str(llm_config.get("base_url"))
            or _as_non_empty_str(os.getenv("OPENAI_API_BASE_URL"))
            or _as_non_empty_str(os.getenv("CUSTOM_LLM_API_BASE_URL"))
        )

    if base_url and "openai.azure.com" not in base_url and not base_url.rstrip("/").endswith("/v1"):
        base_url = f"{base_url.rstrip('/')}/v1"

    logger.info(
        "local_runtime_llm_provider_selected",
        extra={"model": resolved_model, "provider_key": selected_provider_key, "provider_base": provider_base},
    )

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
            "skill_installer",
        }:
            risk_level = "high"
        else:
            risk_level = "low"
        requires_approval = _to_bool(
            cfg.get("requiresApproval"),
            default=tool.name in {
                "code_executor",
                "file_io",
                "browser_automation",
                "http_client",
                "csv_xlsx",
                "sql_query_readonly",
                "skill_installer",
            },
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


def _build_skill_definitions(
    registry: SkillRegistry,
    skill_index: list[dict[str, Any]] | None = None,
) -> list[SkillDefinition]:
    skills: list[SkillDefinition] = []
    seen: set[str] = set()
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
        seen.add(skill_name)

    if not isinstance(skill_index, list):
        return skills

    for item in skill_index:
        if not isinstance(item, dict):
            continue
        skill_id = str(item.get("id") or item.get("name") or "").strip()
        if not skill_id or skill_id in seen:
            continue
        package = item.get("package")
        package_files: list[str] = []
        if isinstance(package, dict):
            files = package.get("files")
            if isinstance(files, list):
                package_files = [
                    str(f.get("path") or "")
                    for f in files
                    if isinstance(f, dict) and str(f.get("path") or "").strip()
                ]
        inventory = item.get("file_inventory") if isinstance(item.get("file_inventory"), dict) else {}
        inventory_scripts = inventory.get("script_files")
        normalized_inventory_scripts = {
            str(path).strip()
            for path in (inventory_scripts if isinstance(inventory_scripts, list) else [])
            if str(path).strip()
        }
        skills.append(
            SkillDefinition(
                id=skill_id,
                name=skill_id,
                description=str(item.get("description") or "").strip() or None,
                version=str(item.get("version") or "").strip() or None,
                source=str(item.get("source") or "local"),
                schema={},
                metadata={
                    "has_skill_md": "SKILL.md" in package_files,
                    "package_files": package_files[:50],
                    "script_files": sorted(normalized_inventory_scripts)[:50],
                },
            )
        )
        seen.add(skill_id)
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


def _guard_rule_authoring_success_claim(final_response: str, tool_results: list[dict[str, Any]]) -> str:
    failed_rows = [
        row
        for row in tool_results
        if str(row.get("tool_name") or "").strip() in {"rule_authoring", "control_plane"}
        and not bool(row.get("success"))
    ]
    if not failed_rows:
        return final_response

    first_error = str(failed_rows[0].get("error") or "").strip() or "unknown_error"
    safe = final_response or ""
    for phrase in (
        "已创建",
        "创建成功",
        "设置成功",
        "已设置",
        "设置完成",
        "任务已设置完成",
    ):
        safe = safe.replace(phrase, "尝试创建但未成功")

    notice = (
        f"注意：控制面变更未成功落地（control_plane 执行失败：{first_error}）。"
        "请修正参数后重试。"
    )
    if not safe.strip():
        return notice
    if notice in safe:
        return safe
    return f"{notice}\n\n{safe}"


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
    tool_definitions = _build_tool_definitions(skill_registry, db_path)

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
            params.get("session_id") or resolved_approval_scope_id,
            max_len=80,
        ) or resolved_approval_scope_id
        scope_key, approval_context = _build_approval_policy(
            tool_name,
            params,
            risk_level,
            scope_session_id,
            metadata_additional,
        )
        approval_context["runtime_session_id"] = resolved_session_id
        approval_context["approval_scope_id"] = resolved_approval_scope_id

        event_signature = hashlib.sha256(scope_key.encode()).hexdigest()[:16]
        event_id = f"{scope_session_id}:{event_signature}"

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
        },
        available_skills=_build_skill_definitions(skill_registry, resolved_skill_index),
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

    runtime_event_emitter = EventEmitter()

    async def _drain_runtime_events() -> None:
        async for event in runtime_event_emitter:
            await _runtime_event_sink(event)

    drain_task = asyncio.create_task(_drain_runtime_events())

    graph_context: dict[str, Any] = {
        "skill_registry": skill_registry,
        "unified_executor": unified_executor,
        "event_emitter": runtime_event_emitter,
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
        final_response = _guard_rule_authoring_success_claim(final_response, tool_results)

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
    finally:
        with suppress(Exception):
            await runtime_event_emitter.close()
        with suppress(Exception):
            await drain_task
