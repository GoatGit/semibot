from __future__ import annotations

import asyncio
import os
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from uuid import uuid4

from src.checkpoint.local_checkpointer import LocalCheckpointer
from src.events.event_engine import EventEngine
from src.events.event_router import EventRouter
from src.events.event_store import EventStore
from src.events.models import Event
from src.events.orchestrator_bridge import OrchestratorBridge
from src.events.runtime_action_executor import RuntimeActionExecutor
from src.events.runtime_event_persistence import persist_runtime_event_to_store
from src.execution.runtime_components import (
    build_runtime_policy,
    build_runtime_skill_definitions,
    build_runtime_tool_definitions,
    resolve_runtime_db_path,
)
from src.execution.runtime_execution_core import (
    build_graph_context,
    build_initial_execution_state,
    build_unified_action_executor,
    emit_chat_message_received,
    invoke_graph_once,
)
from src.execution.runtime_llm import (
    instantiate_llm_provider,
    pick_openai_compatible_provider_key,
    provider_base,
    provider_cfg_base_url,
)
from src.execution.runtime_response import (
    derive_terminal_failure_reason,
    rewrite_premature_final_response,
)
from src.execution.runtime_result import (
    normalize_execution_result,
)
from src.execution.runtime_terminal import derive_terminal_execution_result
from src.llm.anthropic_provider import AnthropicProvider
from src.llm.base import LLMProvider
from src.llm.kimi_provider import KimiProvider
from src.llm.openai_provider import OpenAIProvider
from src.llm.provider_factory import (
    MODEL_PROVIDER_HINTS,
    SUPPORTED_PROVIDER_BASES,
    infer_provider_base_from_model,
)
from src.memory.service import RuntimeMemoryService
from src.orchestrator.context import (
    AgentConfig,
    McpServerDefinition,
    RuntimePolicy,
    RuntimeSessionContext,
    SkillDefinition,
    SubAgentDefinition,
    ToolDefinition,
)
from src.orchestrator.context import (
    parse_model_roles as _parse_model_roles,
)
from src.orchestrator.graph import create_agent_graph
from src.orchestrator.unified_executor import UnifiedActionExecutor
from src.session.runtime_adapter import RuntimeAdapter
from src.session.workspace import (
    materialize_skill_index as _materialize_skill_index,
)
from src.session.workspace import (
    session_working_dir as _shared_session_working_dir,
)
from src.skills.bootstrap import create_default_registry
from src.utils.logging import get_logger
from src.ws.client import ControlPlaneClient
from src.ws.event_emitter import EventEmitter

logger = get_logger(__name__)
_SEMIGRAPH_RUN_HARD_TIMEOUT_SECONDS = float(os.getenv("SEMIBOT_GRAPH_HARD_TIMEOUT_SECONDS", "1200"))

try:
    from src.mcp.bootstrap import setup_mcp_client
except Exception:  # pragma: no cover - optional dependency in local runtime mode
    setup_mcp_client = None


def create_initial_state(*, context: RuntimeSessionContext, **kwargs):
    return build_initial_execution_state(runtime_context=context, **kwargs)


def _session_working_dir(session_id: str) -> str:
    return str(_shared_session_working_dir(session_id))


_OPENAI_COMPATIBLE_PROVIDER_BASES = SUPPORTED_PROVIDER_BASES
_MODEL_PROVIDER_HINTS = MODEL_PROVIDER_HINTS


@dataclass
class RuleExecutionJob:
    """Queued event-rule execution job."""

    job_id: str
    kind: str  # run_agent|execute_plan
    agent_id: str
    message: str
    trace_id: str
    payload: dict[str, Any]


class SemiGraphOrchestratorBridge(OrchestratorBridge):
    """Runtime bridge that executes EventEngine actions via current orchestrator stack."""

    def __init__(self, adapter: SemiGraphAdapter):
        self.adapter = adapter

    async def run_agent(
        self, agent_id: str, payload: dict[str, Any], trace_id: str
    ) -> dict[str, Any]:
        message = str(
            payload.get("message")
            or payload.get("task")
            or payload.get("prompt")
            or payload.get("topic")
            or payload.get("event_type")
            or "请处理事件并给出结果。"
        )
        return await self.adapter.enqueue_rule_run_agent(
            agent_id=agent_id,
            message=message,
            trace_id=trace_id,
            payload=payload,
        )

    async def execute_plan(self, plan: dict[str, Any], trace_id: str) -> dict[str, Any]:
        goal = str(plan.get("goal") or "执行计划")
        steps = plan.get("steps")
        if isinstance(steps, list):
            step_titles = []
            for step in steps[:8]:
                if isinstance(step, dict):
                    step_titles.append(str(step.get("title") or step.get("action") or "step"))
                else:
                    step_titles.append(str(step))
            message = f"{goal}\n步骤：{', '.join(step_titles)}"
        else:
            message = goal
        default_agent_id = str(
            plan.get("agent_id")
            or self.adapter.start_payload.get("agent_id")
            or self.adapter.session_id
        )
        return await self.adapter.enqueue_rule_execute_plan(
            agent_id=default_agent_id,
            message=message,
            trace_id=trace_id,
            payload={"plan": plan},
        )


class SemiGraphAdapter(RuntimeAdapter):
    def __init__(
        self,
        client: ControlPlaneClient,
        session_id: str,
        init_data: dict[str, Any],
        start_payload: dict[str, Any],
        user_id: str = "local",
    ) -> None:
        self.client = client
        self.session_id = session_id
        self.user_id = user_id or "local"
        self.init_data = init_data
        self.start_payload = start_payload
        self._task: asyncio.Task[Any] | None = None

        self._bind_runtime_db_env()
        self.skill_registry = create_default_registry()
        self.llm_provider = self._create_llm_provider()
        self.event_emitter: EventEmitter | None = None
        sessions_root = Path(str(self.init_data.get("memory_dir") or ".semibot/sessions"))
        self.session_root = sessions_root / self.session_id
        self.memory_system = RuntimeMemoryService(
            client=self.client,
            base_dir=str(self.session_root / "memory"),
            llm_provider=self.llm_provider,
            bound_session_id=self.session_id,
            event_emitter=None,
        )
        # act_model will be set in _run_session once agent_cfg is resolved
        self.checkpointer = LocalCheckpointer(str(sessions_root))
        self._event_engine: EventEngine | None = None
        self._rule_job_queue: asyncio.Queue[RuleExecutionJob] | None = None
        self._rule_workers: list[asyncio.Task[Any]] = []
        self._rule_queue_maxsize = int(os.getenv("SEMIBOT_RULE_QUEUE_MAXSIZE") or "100")
        self._rule_worker_count = int(os.getenv("SEMIBOT_RULE_WORKER_COUNT") or "2")
        self._rule_jobs_active = 0
        self._rule_jobs_accepted = 0
        self._rule_jobs_dropped = 0
        self._rule_jobs_completed = 0
        self._rule_jobs_failed = 0
        self._streamed_response_parts: list[str] = []

    def _attempt_identity(self) -> dict[str, Any]:
        attempt_id = str(self.start_payload.get("attempt_id") or "").strip() or None
        user_message_id = str(self.start_payload.get("user_message_id") or "").strip() or None
        return {
            "attempt_id": attempt_id,
            "user_message_id": user_message_id,
        }

    async def _next_checkpoint_revision(self) -> int:
        latest = await self.checkpointer.load_latest(self.session_id)
        current = 0
        if isinstance(latest, dict):
            try:
                current = int(latest.get("revision") or 0)
            except Exception:
                current = 0
        return max(1, current + 1)

    def _bind_runtime_db_env(self) -> None:
        db_path = self._resolve_event_db_path()
        if db_path:
            os.environ["SEMIBOT_EVENTS_DB_PATH"] = db_path

    def _refresh_session_registry(self) -> None:
        previous_count = len(self.skill_registry.list_tools()) if self.skill_registry is not None else 0
        self._bind_runtime_db_env()
        self.skill_registry = create_default_registry()
        logger.info(
            "semigraph_registry_refreshed",
            extra={
                "session_id": self.session_id,
                "previous_tool_count": previous_count,
                "current_tool_count": len(self.skill_registry.list_tools()),
            },
        )

    @staticmethod
    def _serialize_checkpoint_value(value: Any) -> Any:
        if hasattr(value, "model_dump"):
            try:
                return value.model_dump()
            except Exception:
                return value
        if isinstance(value, dict):
            return {
                str(key): SemiGraphAdapter._serialize_checkpoint_value(item)
                for key, item in value.items()
            }
        if isinstance(value, list):
            return [SemiGraphAdapter._serialize_checkpoint_value(item) for item in value]
        return value

    @staticmethod
    def _provider_base(provider_key: str) -> str:
        return provider_base(provider_key)

    @classmethod
    def _infer_openai_compatible_provider_base(cls, model: str) -> str | None:
        return infer_provider_base_from_model(model)

    @classmethod
    def _pick_openai_compatible_provider_key(
        cls,
        model: str,
        api_keys: dict[str, str],
        *,
        strict_preferred_base: bool = False,
    ) -> str | None:
        return pick_openai_compatible_provider_key(
            model,
            api_keys,
            set(_OPENAI_COMPATIBLE_PROVIDER_BASES),
            strict_preferred_base=strict_preferred_base,
        )

    @staticmethod
    def _provider_cfg_base_url(raw_cfg: Any) -> str | None:
        return provider_cfg_base_url(raw_cfg)

    def _create_llm_provider(self) -> LLMProvider | None:
        api_keys_raw = self.init_data.get("api_keys") or {}
        llm_config = self.init_data.get("llm_config") or {}
        providers_cfg = llm_config.get("providers") if isinstance(llm_config, dict) else {}

        api_keys: dict[str, str] = {}
        if isinstance(api_keys_raw, dict):
            for key, value in api_keys_raw.items():
                key_name = str(key or "").strip()
                key_value = str(value or "").strip()
                if key_name and key_value:
                    api_keys[key_name] = key_value

        cfg = self.start_payload.get("agent_config") or {}
        agent_model_provider_key = str(
            cfg.get("model_provider_key") or cfg.get("modelProviderKey") or ""
        ).strip()
        agent_fallback_model = str(
            cfg.get("fallback_model") or cfg.get("fallbackModel") or ""
        ).strip()
        agent_fallback_provider_key = str(
            cfg.get("fallback_provider_key") or cfg.get("fallbackProviderKey") or ""
        ).strip()
        default_model = (
            llm_config.get("default_model") if isinstance(llm_config, dict) else None
        )
        default_provider_key = (
            agent_model_provider_key
            or
            (llm_config.get("default_provider_key") if isinstance(llm_config, dict) else None)
        )
        fallback_provider_key = (
            agent_fallback_provider_key
            or
            (llm_config.get("fallback_provider_key") if isinstance(llm_config, dict) else None)
        )
        agent_model = cfg.get("model")
        model = (
            agent_model
            or default_model
            or agent_fallback_model
            or (llm_config.get("fallback_model") if isinstance(llm_config, dict) else None)
        )

        selected_provider_key = None
        if default_model and str(model or "").strip() == str(default_model).strip():
            if isinstance(default_provider_key, str) and default_provider_key.strip() and api_keys.get(default_provider_key.strip()):
                selected_provider_key = default_provider_key.strip()
        fallback_model = (
            agent_fallback_model
            or (llm_config.get("fallback_model") if isinstance(llm_config, dict) else None)
        )
        if fallback_model and str(model or "").strip() == str(fallback_model).strip():
            if isinstance(fallback_provider_key, str) and fallback_provider_key.strip() and api_keys.get(fallback_provider_key.strip()):
                selected_provider_key = fallback_provider_key.strip()
        if not selected_provider_key:
            selected_provider_key = self._pick_openai_compatible_provider_key(str(model or ""), api_keys)
        if agent_model:
            strict_provider_for_agent_model = self._pick_openai_compatible_provider_key(
                str(agent_model),
                api_keys,
                strict_preferred_base=True,
            )
            default_model_text = str(default_model or "").strip()
            if (
                strict_provider_for_agent_model is None
                and default_model_text
            ):
                default_provider = (
                    default_provider_key.strip()
                    if isinstance(default_provider_key, str)
                    and default_provider_key.strip()
                    and api_keys.get(default_provider_key.strip())
                    else self._pick_openai_compatible_provider_key(default_model_text, api_keys)
                )
                if default_provider:
                    logger.warning(
                        "semigraph_agent_model_fallback_to_default_model",
                        extra={
                            "session_id": self.session_id,
                            "agent_model": str(agent_model),
                            "default_model": default_model_text,
                            "fallback_provider_key": default_provider,
                        },
                    )
                    model = default_model_text
                    selected_provider_key = default_provider
        if not selected_provider_key:
            return None

        api_key = api_keys.get(selected_provider_key)
        if not api_key:
            return None

        provider_base = self._provider_base(selected_provider_key)
        base_url: str | None = None
        if isinstance(providers_cfg, dict):
            base_url = self._provider_cfg_base_url(providers_cfg.get(selected_provider_key))
            if not base_url:
                base_url = self._provider_cfg_base_url(providers_cfg.get(provider_base))

        if (
            base_url
            and "openai.azure.com" not in base_url
            and not base_url.rstrip("/").endswith("/v1")
        ):
            base_url = f"{base_url.rstrip('/')}/v1"

        logger.info(
            "semigraph_llm_provider_selected",
            extra={
                "session_id": self.session_id,
                "model": str(model),
                "provider_key": selected_provider_key,
                "provider_base": provider_base,
            },
        )

        return instantiate_llm_provider(
            model=model,
            api_key=api_key,
            provider_key=selected_provider_key,
            base_url=base_url,
            timeout=120,
            openai_provider_cls=OpenAIProvider,
            kimi_provider_cls=KimiProvider,
            anthropic_provider_cls=AnthropicProvider,
        )

    async def start(self) -> None:
        logger.info("semigraph_session_started", extra={"session_id": self.session_id})

    async def handle_user_message(self, payload: dict[str, Any]) -> None:
        if self._task and not self._task.done():
            self._task.cancel()

        self._task = asyncio.create_task(self._run(payload))

    async def cancel(self) -> None:
        if self._task and not self._task.done():
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                await self.client.send_sse_event(
                    self.session_id,
                    {
                        "type": "execution_complete",
                        "cancelled": True,
                    },
                )
                await self._save_checkpoint(
                    status="cancelled",
                    payload={},
                )
                await self._sync_snapshot()

    async def stop(self) -> None:
        await self.cancel()
        await self._shutdown_rule_workers()
        if self._event_engine:
            await self._event_engine.stop_rule_watch()

    async def _run(self, payload: dict[str, Any]) -> None:
        run_started_at = time.time()
        self._streamed_response_parts = []
        emitter = EventEmitter()
        self.event_emitter = emitter
        self._sync_memory_runtime_hooks(emitter=emitter, runtime_context=None)
        forward_task = asyncio.create_task(self._forward_events(emitter))
        mcp_client: Any = None
        event_engine = self._get_or_create_event_engine()
        event_engine.reload_rules()

        try:
            self._refresh_session_registry()
            agent_cfg = self.start_payload.get("agent_config") or {}
            agent_id = str(self.start_payload.get("agent_id") or self.session_id)
            mcp_servers_raw = self.start_payload.get("mcp_servers") or []
            self._register_skill_tools()
            _materialize_skill_index(
                self.session_id,
                self.start_payload.get("skill_index") if isinstance(self.start_payload.get("skill_index"), list) else None,
            )

            mcp_servers = [
                McpServerDefinition(
                    id=srv.get("id", ""),
                    name=srv.get("name", ""),
                    endpoint=srv.get("endpoint", ""),
                    transport=srv.get("transport", "stdio"),
                    is_connected=bool(srv.get("is_connected", False)),
                    auth_config=srv.get("auth_config"),
                    available_tools=srv.get("available_tools") or [],
                )
                for srv in mcp_servers_raw
                if isinstance(srv, dict)
            ]

            # 建立 MCP 实际连接，避免 capability 里有工具但执行时无 client。
            if callable(setup_mcp_client):
                mcp_client = await setup_mcp_client(mcp_servers)
            else:
                mcp_client = None
            if mcp_client:
                for server in mcp_servers:
                    server.is_connected = mcp_client.is_connected(server.id)

            configured_model = agent_cfg.get("model")
            effective_model = configured_model
            runtime_llm_model = (
                str(getattr(getattr(self.llm_provider, "config", None), "model", "") or "").strip()
                if self.llm_provider
                else ""
            )
            if runtime_llm_model and runtime_llm_model != str(configured_model or "").strip():
                logger.warning(
                    "semigraph_runtime_context_model_overridden",
                    extra={
                        "session_id": self.session_id,
                        "configured_model": str(configured_model or ""),
                        "runtime_llm_model": runtime_llm_model,
                    },
                )
                effective_model = runtime_llm_model

            tool_definitions = self._build_tool_definitions()
            runtime_context = self._create_runtime_context(
                agent_id=agent_id,
                agent_name=agent_id,
                agent_cfg=agent_cfg,
                model_override=effective_model,
                event_engine=event_engine,
                emitter=emitter,
                tool_definitions=tool_definitions,
                mcp_servers=mcp_servers,
                sub_agent_definitions=self._build_sub_agent_definitions(),
            )
            graph, initial_state = self._build_execution_graph_state(
                runtime_context=runtime_context,
                event_engine=event_engine,
                emitter=emitter,
                mcp_client=mcp_client,
                approval_scope_id=str(payload.get("approval_scope_id") or "").strip() or None,
                session_id=self.session_id,
                agent_id=agent_id,
                user_message=str(payload.get("message", "")),
                history_messages=await self._resolve_history(payload),
                metadata=payload.get("metadata") or {},
            )

            await emit_chat_message_received(
                event_engine,
                source="runtime.semigraph_adapter",
                session_id=self.session_id,
                agent_id=agent_id,
                message=str(payload.get("message", "")),
            )
            await self.client.send_runtime_event(
                self.session_id,
                {
                    "event": "graph.invoke.started",
                    "data": {
                        "session_id": self.session_id,
                        "agent_id": agent_id,
                        "timeout_seconds": _SEMIGRAPH_RUN_HARD_TIMEOUT_SECONDS,
                    },
                },
            )
            logger.info(
                "semigraph_graph_invoke_started",
                extra={
                    "session_id": self.session_id,
                    "agent_id": agent_id,
                    "history_len": len(initial_state.get("messages") or []),
                    "skill_count": len(runtime_context.available_skills or []),
                    "tool_count": len(runtime_context.available_tools or []),
                },
            )
            result = await invoke_graph_once(
                graph,
                initial_state,
                timeout_seconds=_SEMIGRAPH_RUN_HARD_TIMEOUT_SECONDS,
            )
            await self.client.send_runtime_event(
                self.session_id,
                {
                    "event": "graph.invoke.completed",
                    "data": {
                        "session_id": self.session_id,
                        "agent_id": agent_id,
                        "duration_ms": int((time.time() - run_started_at) * 1000),
                    },
                },
            )
            logger.info(
                "semigraph_graph_invoke_completed",
                extra={
                    "session_id": self.session_id,
                    "agent_id": agent_id,
                    "duration_ms": int((time.time() - run_started_at) * 1000),
                    "result_keys": sorted(result.keys()) if isinstance(result, dict) else [],
                },
            )

            final_response = rewrite_premature_final_response(result)
            terminal_failure = derive_terminal_failure_reason(result, final_response)
            normalized_result = normalize_execution_result(
                result,
                final_response=final_response,
                terminal_failure_reason=terminal_failure,
            )
            live_pending_approval_ids = self._filter_live_pending_approval_ids(
                list(normalized_result.pending_approval_ids)
            )
            if live_pending_approval_ids != normalized_result.pending_approval_ids:
                normalized_result.pending_approval_ids = live_pending_approval_ids
                if live_pending_approval_ids:
                    if not normalized_result.awaiting_approval_message:
                        normalized_result.awaiting_approval_message = final_response or None
                    normalized_result.final_response = ""
                else:
                    normalized_result.final_response = final_response
                    normalized_result.awaiting_approval_message = None
            terminal_result = derive_terminal_execution_result(normalized_result)
            terminal_revision = await self._next_checkpoint_revision()

            if terminal_result.status == "failed":
                await self.client.send_sse_event(
                    self.session_id,
                    {
                        "type": "execution_error",
                        "code": "INVALID_TERMINAL_RESULT",
                        "error": terminal_result.error,
                        "terminal_reason": terminal_result.terminal_reason,
                        "revision": terminal_revision,
                        **self._attempt_identity(),
                    },
                )
                await event_engine.emit(
                    Event(
                        event_id=f"evt_{self.session_id}_{int(time.time() * 1000)}_failed",
                        event_type="task.failed",
                        source="runtime.semigraph_adapter",
                        subject=self.session_id,
                        payload={
                            "session_id": self.session_id,
                            "agent_id": agent_id,
                            "error": terminal_result.error,
                            "terminal_reason": terminal_result.terminal_reason,
                            "final_response": terminal_result.final_response,
                            "revision": terminal_revision,
                            **self._attempt_identity(),
                        },
                        risk_hint="medium",
                    )
                )
                await self._save_checkpoint(
                    status="failed",
                    payload=payload,
                    result=result,
                    error=terminal_result.error,
                    revision=terminal_revision,
                )
                await self._sync_snapshot()
                logger.info(
                    "semigraph_execution_failed_terminal_validation",
                    extra={
                        "session_id": self.session_id,
                        "agent_id": agent_id,
                        "duration_ms": int((time.time() - run_started_at) * 1000),
                    },
                )
                return

            if terminal_result.status == "awaiting_approval":
                await self.client.send_sse_event(
                    self.session_id,
                    {
                        "type": "execution_complete",
                        "final_response": terminal_result.final_response,
                        "awaiting_approval_message": terminal_result.awaiting_approval_message,
                        "status": "awaiting_approval",
                        "pending_approval_ids": terminal_result.pending_approval_ids,
                        "terminal_reason": terminal_result.terminal_reason,
                        "revision": terminal_revision,
                        **self._attempt_identity(),
                    },
                )
                await event_engine.emit(
                    Event(
                        event_id=f"evt_{self.session_id}_{int(time.time() * 1000)}_awaiting_approval",
                        event_type="task.awaiting_approval",
                        source="runtime.semigraph_adapter",
                        subject=self.session_id,
                        payload={
                            "session_id": self.session_id,
                            "agent_id": agent_id,
                            "final_response": terminal_result.final_response,
                            "awaiting_approval_message": terminal_result.awaiting_approval_message,
                            "pending_approval_ids": terminal_result.pending_approval_ids,
                            "terminal_reason": terminal_result.terminal_reason,
                            "revision": terminal_revision,
                            **self._attempt_identity(),
                        },
                        risk_hint=terminal_result.risk_hint,
                    )
                )
                await self._save_checkpoint(
                    status="awaiting_approval",
                    payload=payload,
                    result=result,
                    revision=terminal_revision,
                )
                await self._sync_snapshot()
                logger.info(
                    "semigraph_execution_awaiting_approval",
                    extra={
                        "session_id": self.session_id,
                        "agent_id": agent_id,
                        "duration_ms": int((time.time() - run_started_at) * 1000),
                        "pending_approval_ids": terminal_result.pending_approval_ids,
                    },
                )
                return

            await self.client.send_sse_event(
                self.session_id,
                {
                    "type": "execution_complete",
                    "final_response": terminal_result.final_response,
                    "status": "completed",
                    "terminal_reason": terminal_result.terminal_reason,
                    "revision": terminal_revision,
                    **self._attempt_identity(),
                },
            )
            await event_engine.emit(
                Event(
                    event_id=f"evt_{self.session_id}_{int(time.time() * 1000)}_done",
                    event_type=terminal_result.event_type,
                    source="runtime.semigraph_adapter",
                    subject=self.session_id,
                    payload={
                        "session_id": self.session_id,
                        "agent_id": agent_id,
                        "final_response": terminal_result.final_response,
                        "terminal_reason": terminal_result.terminal_reason,
                        "revision": terminal_revision,
                        **self._attempt_identity(),
                    },
                    risk_hint=terminal_result.risk_hint,
                )
            )
            await self._save_checkpoint(
                status="completed",
                payload=payload,
                result=result,
                revision=terminal_revision,
            )
            await self._sync_snapshot()
            logger.info(
                "semigraph_execution_completed",
                extra={
                    "session_id": self.session_id,
                    "agent_id": agent_id,
                    "duration_ms": int((time.time() - run_started_at) * 1000),
                    "final_response_chars": len(final_response),
                },
            )

        except asyncio.CancelledError:
            terminal_revision = await self._next_checkpoint_revision()
            await self.client.send_sse_event(
                self.session_id,
                {
                    "type": "execution_complete",
                    "cancelled": True,
                    "status": "cancelled",
                    "terminal_reason": "cancelled",
                    "revision": terminal_revision,
                    **self._attempt_identity(),
                },
            )
            await event_engine.emit(
                Event(
                    event_id=f"evt_{self.session_id}_{int(time.time() * 1000)}_cancel",
                    event_type="task.cancelled",
                    source="runtime.semigraph_adapter",
                    subject=self.session_id,
                    payload={
                        "session_id": self.session_id,
                        "terminal_reason": "cancelled",
                        "revision": terminal_revision,
                        **self._attempt_identity(),
                    },
                    risk_hint="low",
                )
            )
            await self._save_checkpoint(
                status="cancelled",
                payload=payload,
                revision=terminal_revision,
            )
            await self._sync_snapshot()
            logger.info(
                "semigraph_execution_cancelled",
                extra={
                    "session_id": self.session_id,
                    "duration_ms": int((time.time() - run_started_at) * 1000),
                },
            )
        except TimeoutError:
            error_text = f"graph execution timed out after {_SEMIGRAPH_RUN_HARD_TIMEOUT_SECONDS:g}s"
            terminal_revision = await self._next_checkpoint_revision()
            await self.client.send_runtime_event(
                self.session_id,
                {
                    "event": "graph.invoke.failed",
                    "data": {
                        "session_id": self.session_id,
                        "agent_id": agent_id,
                        "error": error_text,
                        "duration_ms": int((time.time() - run_started_at) * 1000),
                    },
                },
            )
            await self.client.send_sse_event(
                self.session_id,
                {
                    "type": "execution_error",
                    "code": "GRAPH_TIMEOUT",
                    "error": error_text,
                    "terminal_reason": "graph_timeout",
                    "revision": terminal_revision,
                    **self._attempt_identity(),
                },
            )
            await event_engine.emit(
                Event(
                    event_id=f"evt_{self.session_id}_{int(time.time() * 1000)}_failed",
                    event_type="task.failed",
                    source="runtime.semigraph_adapter",
                    subject=self.session_id,
                    payload={
                        "session_id": self.session_id,
                        "agent_id": agent_id,
                        "error": error_text,
                        "terminal_reason": "graph_timeout",
                        "revision": terminal_revision,
                        **self._attempt_identity(),
                    },
                    risk_hint="medium",
                )
            )
            await self._save_checkpoint(
                status="failed",
                payload=payload,
                error=error_text,
                revision=terminal_revision,
            )
            await self._sync_snapshot()
            logger.warning(
                "semigraph_execution_timed_out",
                extra={
                    "session_id": self.session_id,
                    "agent_id": agent_id,
                    "duration_ms": int((time.time() - run_started_at) * 1000),
                    "timeout_seconds": _SEMIGRAPH_RUN_HARD_TIMEOUT_SECONDS,
                },
            )
        except Exception as exc:
            logger.error(
                "semigraph_execution_failed",
                extra={"session_id": self.session_id, "error": str(exc)},
            )
            terminal_revision = await self._next_checkpoint_revision()
            await self.client.send_runtime_event(
                self.session_id,
                {
                    "event": "graph.invoke.failed",
                    "data": {
                        "session_id": self.session_id,
                        "agent_id": agent_id,
                        "error": str(exc),
                        "duration_ms": int((time.time() - run_started_at) * 1000),
                    },
                },
            )
            await self.client.send_sse_event(
                self.session_id,
                {
                    "type": "execution_error",
                    "code": "INTERNAL_ERROR",
                    "error": str(exc),
                    "terminal_reason": "graph_exception",
                    "revision": terminal_revision,
                    **self._attempt_identity(),
                },
            )
            await event_engine.emit(
                Event(
                    event_id=f"evt_{self.session_id}_{int(time.time() * 1000)}_failed",
                    event_type="task.failed",
                    source="runtime.semigraph_adapter",
                    subject=self.session_id,
                    payload={
                        "session_id": self.session_id,
                        "error": str(exc),
                        "terminal_reason": "graph_exception",
                        "revision": terminal_revision,
                        **self._attempt_identity(),
                    },
                    risk_hint="medium",
                )
            )
            await self._save_checkpoint(
                status="failed",
                payload=payload,
                error=str(exc),
                revision=terminal_revision,
            )
            await self._sync_snapshot()
            logger.info(
                "semigraph_execution_failed_exception",
                extra={
                    "session_id": self.session_id,
                    "duration_ms": int((time.time() - run_started_at) * 1000),
                    "error": str(exc),
                },
            )
        finally:
            await emitter.close()
            await forward_task
            if mcp_client:
                try:
                    await mcp_client.close_all()
                except Exception:
                    logger.warning("mcp_close_all_failed", extra={"session_id": self.session_id})

    def _resolve_event_db_path(self) -> str:
        configured = (
            self.start_payload.get("events_db_path")
            or self.init_data.get("events_db_path")
            or os.getenv("SEMIBOT_EVENTS_DB_PATH")
        )
        if isinstance(configured, str) and configured.strip():
            return str(Path(configured).expanduser())
        sessions_root = Path(str(self.init_data.get("memory_dir") or ".semibot/sessions"))
        sessions_root.mkdir(parents=True, exist_ok=True)
        return str((sessions_root / "event-engine.db").expanduser())

    def _resolve_rules_path(self) -> str:
        configured = (
            self.start_payload.get("rules_path")
            or self.init_data.get("rules_path")
            or os.getenv("SEMIBOT_RULES_PATH")
            or "~/.semibot/rules"
        )
        return str(Path(str(configured)).expanduser())

    def _filter_live_pending_approval_ids(self, approval_ids: list[str]) -> list[str]:
        if not approval_ids:
            return []

        store = EventStore(self._resolve_event_db_path())
        filtered: list[str] = []
        for item in approval_ids:
            approval_id = str(item or "").strip()
            if not approval_id:
                continue
            try:
                approval = store.get_approval(approval_id)
            except Exception:
                approval = None
            if approval is None:
                filtered.append(approval_id)
                continue
            if str(approval.status or "").strip().lower() == "pending":
                filtered.append(approval_id)
        return list(dict.fromkeys(filtered))

    def _get_or_create_event_engine(self) -> EventEngine:
        if self._event_engine is not None:
            return self._event_engine

        identity = self._attempt_identity()
        attempt_id = identity["attempt_id"]
        user_message_id = identity["user_message_id"]

        async def _runtime_event_sink(event: dict[str, Any]) -> None:
            if attempt_id or user_message_id:
                data = event.get("data")
                normalized_data = dict(data) if isinstance(data, dict) else {}
                if attempt_id:
                    normalized_data.setdefault("attempt_id", attempt_id)
                if user_message_id:
                    normalized_data.setdefault("user_message_id", user_message_id)
                event = {**event, "data": normalized_data}
            await self.client.send_runtime_event(self.session_id, event)

        action_executor = RuntimeActionExecutor(
            runtime_event_sink=_runtime_event_sink,
            orchestrator_bridge=SemiGraphOrchestratorBridge(self),
        )
        router = EventRouter(action_executor)
        self._event_engine = EventEngine(
            store=EventStore(self._resolve_event_db_path()),
            router=router,
            rules_path=self._resolve_rules_path(),
        )
        return self._event_engine

    async def _ensure_rule_workers(self) -> None:
        if self._rule_job_queue is None:
            self._rule_job_queue = asyncio.Queue(maxsize=max(self._rule_queue_maxsize, 1))

        if self._rule_workers:
            self._rule_workers = [worker for worker in self._rule_workers if not worker.done()]
            if self._rule_workers:
                return

        worker_count = max(self._rule_worker_count, 1)
        self._rule_workers = [
            asyncio.create_task(self._rule_worker_loop(index)) for index in range(worker_count)
        ]

    async def _shutdown_rule_workers(self) -> None:
        if not self._rule_workers:
            return
        for worker in self._rule_workers:
            worker.cancel()
        for worker in self._rule_workers:
            try:
                await worker
            except asyncio.CancelledError:
                pass
        self._rule_workers = []

    async def enqueue_rule_run_agent(
        self,
        *,
        agent_id: str,
        message: str,
        trace_id: str,
        payload: dict[str, Any],
    ) -> dict[str, Any]:
        await self._ensure_rule_workers()
        job = RuleExecutionJob(
            job_id=f"job_{uuid4().hex}",
            kind="run_agent",
            agent_id=agent_id,
            message=message,
            trace_id=trace_id,
            payload=payload,
        )
        return await self._enqueue_rule_job(job)

    async def enqueue_rule_execute_plan(
        self,
        *,
        agent_id: str,
        message: str,
        trace_id: str,
        payload: dict[str, Any],
    ) -> dict[str, Any]:
        await self._ensure_rule_workers()
        job = RuleExecutionJob(
            job_id=f"job_{uuid4().hex}",
            kind="execute_plan",
            agent_id=agent_id,
            message=message,
            trace_id=trace_id,
            payload=payload,
        )
        return await self._enqueue_rule_job(job)

    async def _enqueue_rule_job(self, job: RuleExecutionJob) -> dict[str, Any]:
        if self._rule_job_queue is None:
            return {"accepted": False, "error": "queue_not_ready"}

        try:
            self._rule_job_queue.put_nowait(job)
        except asyncio.QueueFull:
            self._rule_jobs_dropped += 1
            await self.client.send_runtime_event(
                self.session_id,
                {
                    "event": "rule.queue.dropped",
                    "data": {
                        "job_id": job.job_id,
                        "kind": job.kind,
                        "agent_id": job.agent_id,
                        "reason": "queue_full",
                    },
                },
            )
            await self._emit_internal_event(
                "rule.queue.dropped",
                {
                    "session_id": self.session_id,
                    "job_id": job.job_id,
                    "kind": job.kind,
                    "agent_id": job.agent_id,
                    "reason": "queue_full",
                },
            )
            await self._emit_queue_telemetry(trigger="queue_dropped")
            return {"accepted": False, "job_id": job.job_id, "reason": "queue_full"}

        self._rule_jobs_accepted += 1
        queued_depth = self._rule_job_queue.qsize()
        await self.client.send_runtime_event(
            self.session_id,
            {
                "event": "rule.queue.accepted",
                "data": {
                    "job_id": job.job_id,
                    "kind": job.kind,
                    "agent_id": job.agent_id,
                    "trace_id": job.trace_id,
                    "queued_depth": queued_depth,
                },
            },
        )
        await self._emit_internal_event(
            "rule.queue.accepted",
            {
                "session_id": self.session_id,
                "job_id": job.job_id,
                "kind": job.kind,
                "agent_id": job.agent_id,
                "trace_id": job.trace_id,
                "queued_depth": queued_depth,
            },
        )
        await self._emit_queue_telemetry(trigger="queue_accepted")
        return {"accepted": True, "job_id": job.job_id, "queued_depth": queued_depth}

    async def _rule_worker_loop(self, worker_index: int) -> None:
        if self._rule_job_queue is None:
            return
        queue = self._rule_job_queue
        while True:
            job = await queue.get()
            try:
                self._rule_jobs_active += 1
                await self.client.send_runtime_event(
                    self.session_id,
                    {
                        "event": "rule.worker.started",
                        "data": {
                            "worker": worker_index,
                            "job_id": job.job_id,
                            "kind": job.kind,
                            "agent_id": job.agent_id,
                            "trace_id": job.trace_id,
                        },
                    },
                )
                await self._emit_internal_event(
                    "rule.worker.started",
                    {
                        "session_id": self.session_id,
                        "worker": worker_index,
                        "job_id": job.job_id,
                        "kind": job.kind,
                        "agent_id": job.agent_id,
                        "trace_id": job.trace_id,
                    },
                )
                await self._emit_queue_telemetry(trigger="worker_started")
                await self._run_rule_triggered_agent(
                    agent_id=job.agent_id,
                    message=job.message,
                    trace_id=job.trace_id,
                    payload=job.payload,
                )
                self._rule_jobs_completed += 1
                await self.client.send_runtime_event(
                    self.session_id,
                    {
                        "event": "rule.worker.completed",
                        "data": {
                            "worker": worker_index,
                            "job_id": job.job_id,
                            "kind": job.kind,
                            "agent_id": job.agent_id,
                            "trace_id": job.trace_id,
                        },
                    },
                )
                await self._emit_internal_event(
                    "rule.worker.completed",
                    {
                        "session_id": self.session_id,
                        "worker": worker_index,
                        "job_id": job.job_id,
                        "kind": job.kind,
                        "agent_id": job.agent_id,
                        "trace_id": job.trace_id,
                    },
                )
            except Exception as exc:
                self._rule_jobs_failed += 1
                logger.warning(
                    "rule_worker_job_failed",
                    extra={
                        "session_id": self.session_id,
                        "job_id": job.job_id,
                        "error": str(exc),
                    },
                )
                await self.client.send_runtime_event(
                    self.session_id,
                    {
                        "event": "rule.worker.failed",
                        "data": {
                            "worker": worker_index,
                            "job_id": job.job_id,
                            "kind": job.kind,
                            "agent_id": job.agent_id,
                            "trace_id": job.trace_id,
                            "error": str(exc),
                        },
                    },
                )
                await self._emit_internal_event(
                    "rule.worker.failed",
                    {
                        "session_id": self.session_id,
                        "worker": worker_index,
                        "job_id": job.job_id,
                        "kind": job.kind,
                        "agent_id": job.agent_id,
                        "trace_id": job.trace_id,
                        "error": str(exc),
                    },
                )
            finally:
                self._rule_jobs_active = max(self._rule_jobs_active - 1, 0)
                await self._emit_queue_telemetry(trigger="worker_finished")
                queue.task_done()

    def get_rule_queue_snapshot(self) -> dict[str, Any]:
        """Return current queue telemetry snapshot."""
        queued_depth = self._rule_job_queue.qsize() if self._rule_job_queue else 0
        running_workers = len([worker for worker in self._rule_workers if not worker.done()])
        return {
            "queued_depth": queued_depth,
            "active_jobs": self._rule_jobs_active,
            "accepted_jobs": self._rule_jobs_accepted,
            "dropped_jobs": self._rule_jobs_dropped,
            "completed_jobs": self._rule_jobs_completed,
            "failed_jobs": self._rule_jobs_failed,
            "running_workers": running_workers,
            "configured_workers": max(self._rule_worker_count, 1),
            "queue_maxsize": max(self._rule_queue_maxsize, 1),
        }

    async def _emit_queue_telemetry(self, *, trigger: str) -> None:
        payload = {
            "session_id": self.session_id,
            "trigger": trigger,
            **self.get_rule_queue_snapshot(),
        }
        await self.client.send_runtime_event(
            self.session_id,
            {"event": "rule.queue.telemetry", "data": payload},
        )
        await self._emit_internal_event("rule.queue.telemetry", payload)

    async def _emit_internal_event(self, event_type: str, payload: dict[str, Any]) -> None:
        """Mirror runtime queue/worker activity to EventEngine for dashboard queries."""
        event_engine = self._event_engine
        if event_engine is None:
            return
        try:
            await event_engine.emit(
                Event(
                    event_id=f"evt_{uuid4().hex}",
                    event_type=event_type,
                    source="runtime.semigraph_adapter",
                    subject=self.session_id,
                    payload=payload,
                    risk_hint="low",
                )
            )
        except Exception as exc:
            logger.debug(
                "emit_internal_event_failed",
                extra={
                    "session_id": self.session_id,
                    "event_type": event_type,
                    "error": str(exc),
                },
            )

    async def _run_rule_triggered_agent(
        self,
        *,
        agent_id: str,
        message: str,
        trace_id: str,
        payload: dict[str, Any],
    ) -> dict[str, Any]:
        self._refresh_session_registry()
        event_engine = self._get_or_create_event_engine()
        emitter = EventEmitter()
        self.event_emitter = emitter
        self._sync_memory_runtime_hooks(emitter=emitter, runtime_context=None)
        forward_task = asyncio.create_task(self._forward_events(emitter))
        agent_cfg = self.start_payload.get("agent_config") or {}
        resolved_cfg = self._resolve_agent_config(agent_id, agent_cfg)
        try:
            tool_definitions = self._build_tool_definitions()
            sub_agent_definitions = self._build_sub_agent_definitions()
            runtime_context = self._create_runtime_context(
                agent_id=agent_id,
                agent_name=str(resolved_cfg.get("name") or agent_id),
                agent_cfg=resolved_cfg,
                event_engine=event_engine,
                emitter=emitter,
                tool_definitions=tool_definitions,
                mcp_servers=[],
                sub_agent_definitions=sub_agent_definitions,
                enable_delegation=bool(sub_agent_definitions),
            )
            graph, initial_state = self._build_execution_graph_state(
                runtime_context=runtime_context,
                event_engine=event_engine,
                emitter=emitter,
                mcp_client=None,
                approval_scope_id=str(payload.get("approval_scope_id") or "").strip() or None,
                session_id=self.session_id,
                agent_id=agent_id,
                user_message=message,
                history_messages=None,
                metadata={
                    "trigger": "event_rule",
                    "trace_id": trace_id,
                    "event_payload": payload,
                },
            )

            result = await invoke_graph_once(graph, initial_state)
            final_response = rewrite_premature_final_response(result)

            await self.client.send_runtime_event(
                self.session_id,
                {
                    "event": "rule.run_agent.completed",
                    "data": {
                        "trace_id": trace_id,
                        "agent_id": agent_id,
                        "message": message,
                        "final_response": final_response,
                    },
                },
            )
            return {
                "success": True,
                "agent_id": agent_id,
                "trace_id": trace_id,
                "final_response": final_response,
            }
        finally:
            await emitter.close()
            await forward_task

    def _resolve_agent_config(self, agent_id: str, base_config: dict[str, Any]) -> dict[str, Any]:
        """Resolve effective agent config by target id (main agent or sub-agent)."""
        if not isinstance(base_config, dict):
            base_config = {}
        for item in self.start_payload.get("sub_agents") or []:
            if not isinstance(item, dict):
                continue
            item_id = str(item.get("id") or "").strip()
            if item_id and item_id == agent_id:
                merged = dict(base_config)
                merged.update(item)
                return merged
        return base_config

    def _runtime_metadata(self, event_engine: EventEngine) -> dict[str, Any]:
        return {
            "event_emitter": event_engine,
            "org_id": str(self.init_data.get("org_id") or "").strip() or None,
            "skill_registry": self.skill_registry,
            "llm_provider": self.llm_provider,
            "memory_service": self.memory_system,
            "skill_index": self.start_payload.get("skill_index")
            if isinstance(self.start_payload.get("skill_index"), list)
            else [],
            "recent_tool_usage": dict(self.start_payload.get("recent_tool_usage") or {})
            if isinstance(self.start_payload.get("recent_tool_usage"), dict)
            else {},
            "session_working_dir": _session_working_dir(self.session_id),
        }

    def _create_runtime_context(
        self,
        *,
        agent_id: str,
        agent_name: str,
        agent_cfg: dict[str, Any],
        event_engine: EventEngine,
        emitter: EventEmitter,
        tool_definitions: list[ToolDefinition],
        mcp_servers: list[McpServerDefinition],
        sub_agent_definitions: list[SubAgentDefinition],
        model_override: str | None = None,
        enable_delegation: bool | None = None,
    ) -> RuntimeSessionContext:
        runtime_context = RuntimeSessionContext(
            user_id=self.user_id,
            agent_id=agent_id,
            session_id=self.session_id,
            agent_config=AgentConfig(
                id=agent_id,
                name=agent_name,
                system_prompt=agent_cfg.get("system_prompt"),
                model=model_override if model_override is not None else agent_cfg.get("model"),
                temperature=float(agent_cfg.get("temperature", 0.7)),
                max_tokens=int(agent_cfg.get("max_tokens", 4096)),
                model_roles=_parse_model_roles(agent_cfg.get("model_roles")),
            ),
            metadata=self._runtime_metadata(event_engine),
            available_skills=self._build_skill_definitions(),
            available_tools=tool_definitions,
            available_mcp_servers=mcp_servers,
            available_sub_agents=sub_agent_definitions,
            runtime_policy=self._build_runtime_policy(
                tool_definitions,
                enable_delegation=enable_delegation,
            ),
        )
        self._sync_memory_runtime_hooks(emitter=emitter, runtime_context=runtime_context)
        return runtime_context

    def _build_execution_graph_state(
        self,
        *,
        runtime_context: RuntimeSessionContext,
        event_engine: EventEngine,
        emitter: EventEmitter,
        mcp_client: Any,
        approval_scope_id: str | None = None,
        session_id: str,
        agent_id: str,
        user_message: str,
        history_messages: list[dict[str, Any]] | None,
        metadata: dict[str, Any],
    ) -> tuple[Any, dict[str, Any]]:
        unified_executor = build_unified_action_executor(
            runtime_context=runtime_context,
            skill_registry=self.skill_registry,
            event_engine=event_engine,
            default_session_id=self.session_id,
            approval_scope_id=approval_scope_id or self.session_id,
            attempt_id=str(metadata.get("attempt_id") or self.start_payload.get("attempt_id") or "").strip() or None,
            user_message_id=str(metadata.get("user_message_id") or self.start_payload.get("user_message_id") or "").strip() or None,
            mcp_client=mcp_client,
            executor_cls=UnifiedActionExecutor,
        )
        graph_context = build_graph_context(
            skill_registry=self.skill_registry,
            unified_executor=unified_executor,
            emitter=emitter,
            memory_system=self.memory_system,
            llm_provider=self.llm_provider,
        )
        graph = create_agent_graph(context=graph_context, runtime_context=runtime_context)
        initial_state = create_initial_state(
            session_id=session_id,
            agent_id=agent_id,
            user_message=user_message,
            context=runtime_context,
            history_messages=history_messages,
            metadata=metadata,
        )
        return graph, initial_state

    async def _forward_events(self, emitter: EventEmitter) -> None:
        attempt_id = str(self.start_payload.get("attempt_id") or "").strip() or None
        user_message_id = str(self.start_payload.get("user_message_id") or "").strip() or None
        async for event in emitter:
            if isinstance(event, dict) and str(event.get("event") or "") in {"text_chunk", "text"}:
                data = event.get("data")
                if isinstance(data, dict):
                    content = str(data.get("content") or "")
                    if content:
                        self._streamed_response_parts.append(content)
            if isinstance(event, dict) and (attempt_id or user_message_id):
                data = event.get("data")
                normalized_data = dict(data) if isinstance(data, dict) else {}
                if attempt_id:
                    normalized_data.setdefault("attempt_id", attempt_id)
                if user_message_id:
                    normalized_data.setdefault("user_message_id", user_message_id)
                event = {**event, "data": normalized_data}
            await self.client.send_runtime_event(self.session_id, event)
            persist_runtime_event_to_store(self._event_engine, event)

    async def _resolve_history(self, payload: dict[str, Any]) -> Any:
        history = payload.get("history")
        if history:
            return self._sanitize_conversation_history(history)

        latest = await self.checkpointer.load_latest(self.session_id)
        if not latest:
            return None
        restored = latest.get("conversation_history")
        if isinstance(restored, list):
            return self._sanitize_conversation_history(restored)
        restored = latest.get("history")
        return self._sanitize_conversation_history(restored) if isinstance(restored, list) else None

    @staticmethod
    def _sanitize_conversation_history(history: Any) -> list[dict[str, Any]] | None:
        if not isinstance(history, list):
            return None
        sanitized: list[dict[str, Any]] = []
        blocked_prefixes = (
            "[SYSTEM] REPLAN",
            "[SYSTEM] STOP",
            "[SYSTEM] FAILURE REFLECTION",
        )
        for msg in history:
            if not isinstance(msg, dict):
                continue
            role = str(msg.get("role") or "").strip().lower()
            content = msg.get("content")
            if role not in {"user", "assistant"} or not isinstance(content, str):
                continue
            text = content.strip()
            if not text:
                continue
            if text.startswith(blocked_prefixes):
                continue
            sanitized.append({"role": role, "content": text})
        return sanitized or None

    @staticmethod
    def _read_pending_approval_ids(value: Any) -> list[str]:
        if not isinstance(value, list):
            return []
        ids: list[str] = []
        for item in value:
            text = str(item or "").strip()
            if text:
                ids.append(text)
        return ids

    @classmethod
    def _is_awaiting_approval_history_message(
        cls,
        item: dict[str, Any],
        *,
        awaiting_approval_message: str,
    ) -> bool:
        role = str(item.get("role") or "").strip().lower()
        if role != "assistant":
            return False
        metadata = item.get("metadata")
        if isinstance(metadata, dict):
            status = str(metadata.get("status") or "").strip().lower()
            if status == "awaiting_approval":
                return True
            if cls._read_pending_approval_ids(metadata.get("pending_approval_ids")):
                return True
        content = str(item.get("content") or "").strip()
        return bool(awaiting_approval_message and content and content == awaiting_approval_message)

    @staticmethod
    def _extract_last_assistant_message_content(messages: Any) -> str:
        if not isinstance(messages, list):
            return ""
        for item in reversed(messages):
            if not isinstance(item, dict):
                continue
            role = str(item.get("role") or "").strip().lower()
            if role != "assistant":
                continue
            content = str(item.get("content") or "").strip()
            if content:
                return content
        return ""

    async def _save_checkpoint(
        self,
        *,
        status: str,
        payload: dict[str, Any],
        result: dict[str, Any] | None = None,
        error: str | None = None,
        revision: int | None = None,
    ) -> None:
        messages = result.get("messages") if isinstance(result, dict) else None
        if not isinstance(messages, list):
            messages = payload.get("history")
        final_response = (
            rewrite_premature_final_response(result)
            if isinstance(result, dict)
            else ""
        )
        if not final_response.strip() and self._streamed_response_parts:
            final_response = "".join(self._streamed_response_parts).strip()
        tool_results = (
            [row.model_dump() if hasattr(row, "model_dump") else dict(row) if isinstance(row, dict) else {
                "tool_name": str(getattr(row, "tool_name", "") or ""),
                "params": dict(getattr(row, "params", {}) or {}) if isinstance(getattr(row, "params", None), dict) else {},
                "result": getattr(row, "result", None),
                "error": getattr(row, "error", None),
                "duration_ms": int(getattr(row, "duration_ms", 0) or 0),
                "success": bool(getattr(row, "success", False)),
                "metadata": getattr(row, "metadata", {}) or {},
            } for row in result.get("tool_results", [])]
            if isinstance(result, dict) and isinstance(result.get("tool_results"), list)
            else []
        )
        result_metadata = result.get("metadata") if isinstance(result, dict) and isinstance(result.get("metadata"), dict) else {}
        serialized_plan = None
        if isinstance(result, dict) and result.get("plan") is not None:
            serialized_plan = self._serialize_checkpoint_value(result.get("plan"))
        checkpoint_current_date = ""
        checkpoint_current_weekday = ""
        checkpoint_current_timezone = ""
        if isinstance(serialized_plan, dict):
            checkpoint_current_date = str(serialized_plan.get("current_date") or "").strip()
            checkpoint_current_weekday = str(serialized_plan.get("current_weekday") or "").strip()
            checkpoint_current_timezone = str(serialized_plan.get("current_timezone") or "").strip()
        if not checkpoint_current_date:
            checkpoint_current_date = str(result_metadata.get("current_date") or "").strip()
        if not checkpoint_current_weekday:
            checkpoint_current_weekday = str(result_metadata.get("current_weekday") or "").strip()
        if not checkpoint_current_timezone:
            checkpoint_current_timezone = str(result_metadata.get("current_timezone") or "").strip()
        checkpoint_status = str(status or "").strip().lower()
        is_awaiting_approval = checkpoint_status == "awaiting_approval"
        awaiting_approval_message = (
            str(result_metadata.get("awaiting_approval_message") or "").strip()
            if is_awaiting_approval
            else ""
        )
        if is_awaiting_approval and not awaiting_approval_message:
            awaiting_approval_message = final_response
        if is_awaiting_approval and not awaiting_approval_message:
            awaiting_approval_message = self._extract_last_assistant_message_content(messages)
        pending_approval_ids = self._read_pending_approval_ids(
            result_metadata.get("pending_approval_ids") if isinstance(result_metadata, dict) else None
        )
        checkpoint_history = messages if isinstance(messages, list) else []
        if is_awaiting_approval:
            filtered_history: list[dict[str, Any]] = []
            for item in checkpoint_history:
                if not isinstance(item, dict):
                    continue
                if self._is_awaiting_approval_history_message(
                    item,
                    awaiting_approval_message=awaiting_approval_message,
                ):
                    continue
                filtered_history.append(item)
            checkpoint_history = filtered_history
            if not checkpoint_history:
                last_user_message = str(payload.get("message", "")).strip()
                if last_user_message:
                    checkpoint_history = [{"role": "user", "content": last_user_message}]
            final_response = ""
        if not checkpoint_history and final_response:
            last_user_message = str(payload.get("message", "")).strip()
            rebuilt_history: list[dict[str, Any]] = []
            if last_user_message:
                rebuilt_history.append({"role": "user", "content": last_user_message})
            rebuilt_history.append({"role": "assistant", "content": final_response})
            checkpoint_history = rebuilt_history
        agent_cfg = self.start_payload.get("agent_config")
        resume_task_config: dict[str, Any] = {}
        if isinstance(agent_cfg, dict):
            raw_model_roles = agent_cfg.get("model_roles")
            if isinstance(raw_model_roles, dict):
                resume_task_config["model_roles"] = self._serialize_checkpoint_value(raw_model_roles)
            for field in (
                "model",
                "model_provider_key",
                "fallback_model",
                "fallback_provider_key",
                "system_prompt",
            ):
                value = agent_cfg.get(field)
                if isinstance(value, str):
                    text = value.strip()
                    if text:
                        resume_task_config[field] = text
        agent_id = str(self.start_payload.get("agent_id") or "").strip()
        if agent_id:
            resume_task_config["agent_id"] = agent_id
        approval_scope_id = str(
            payload.get("approval_scope_id")
            or self.start_payload.get("approval_scope_id")
            or ""
        ).strip()
        if approval_scope_id:
            resume_task_config["approval_scope_id"] = approval_scope_id
        attempt_id = str(
            payload.get("attempt_id")
            or self.start_payload.get("attempt_id")
            or ""
        ).strip()
        user_message_id = str(
            payload.get("user_message_id")
            or self.start_payload.get("user_message_id")
            or ""
        ).strip()
        if attempt_id:
            resume_task_config["attempt_id"] = attempt_id
        if user_message_id:
            resume_task_config["user_message_id"] = user_message_id
        checkpoint_revision = max(1, int(revision or 1))

        checkpoint = {
            "id": str(int(time.time() * 1000)),
            "session_id": self.session_id,
            "attempt_id": attempt_id or None,
            "user_message_id": user_message_id or None,
            "status": status,
            "revision": checkpoint_revision,
            "history": checkpoint_history,
            "conversation_history": self._sanitize_conversation_history(checkpoint_history),
            "last_user_message": str(payload.get("message", "")),
            "updated_at": int(time.time()),
            "final_response": final_response,
            "tool_results": tool_results,
            "resume_task_config": resume_task_config,
        }
        if pending_approval_ids:
            checkpoint["pending_approval_ids"] = pending_approval_ids
        if checkpoint_current_date:
            checkpoint["current_date"] = checkpoint_current_date
        if checkpoint_current_weekday:
            checkpoint["current_weekday"] = checkpoint_current_weekday
        if checkpoint_current_timezone:
            checkpoint["current_timezone"] = checkpoint_current_timezone
        if isinstance(result, dict):
            if serialized_plan is not None:
                checkpoint["plan"] = serialized_plan
            if isinstance(result.get("execution_state"), dict):
                checkpoint["execution_state"] = self._serialize_checkpoint_value(
                    result.get("execution_state")
                )
        if result_metadata:
            checkpoint["metadata"] = dict(result_metadata)
        if awaiting_approval_message:
            metadata = checkpoint.setdefault("metadata", {})
            if isinstance(metadata, dict):
                metadata["awaiting_approval_message"] = awaiting_approval_message
            checkpoint["awaiting_approval_message"] = awaiting_approval_message
        if error:
            checkpoint["error"] = error
        terminal_reason = ""
        if isinstance(result_metadata, dict):
            terminal_reason = str(result_metadata.get("terminal_reason") or "").strip()
        if not terminal_reason:
            terminal_reason = str(payload.get("terminal_reason") or "").strip()
        if not terminal_reason and checkpoint_status == "cancelled":
            terminal_reason = "cancelled"
        if not terminal_reason and checkpoint_status == "completed":
            terminal_reason = "completed_normally"
        if error and not terminal_reason:
            terminal_reason = "graph_exception"
        if terminal_reason:
            checkpoint["terminal_reason"] = terminal_reason
        await self.checkpointer.save(self.session_id, checkpoint)

    async def _sync_snapshot(self) -> None:
        fire_and_forget = getattr(self.client, "fire_and_forget", None)
        if not callable(fire_and_forget):
            return
        try:
            await fire_and_forget(
                self.session_id,
                "snapshot_sync",
                checkpoint=await self.checkpointer.get_all_for_snapshot(self.session_id),
                short_term_memory=await self.memory_system.snapshot_short_term(self.session_id),
            )
        except Exception as exc:
            logger.warning(
                "snapshot_sync_failed", extra={"session_id": self.session_id, "error": str(exc)}
            )

    def _build_tool_definitions(self) -> list[ToolDefinition]:
        return build_runtime_tool_definitions(
            self.skill_registry,
            resolve_runtime_db_path(),
            metadata_resolver=self._resolve_tool_definition_metadata,
        )

    def _resolve_tool_definition_metadata(self, tool_name: str) -> dict[str, Any]:
        tool_metadata = self.skill_registry.get_tool_metadata(tool_name)
        additional = (
            dict(getattr(tool_metadata, "additional", {}) or {})
            if tool_metadata is not None
            else {}
        )
        source = str(getattr(tool_metadata, "source", None) or "builtin").strip() or "builtin"
        return {
            **additional,
            "source": source,
        }

    def _build_runtime_policy(
        self,
        tools: list[ToolDefinition],
        *,
        enable_delegation: bool | None = None,
    ) -> RuntimePolicy:
        return build_runtime_policy(
            tools,
            enable_delegation=(
                bool(self._build_sub_agent_definitions())
                if enable_delegation is None
                else enable_delegation
            ),
        )

    def _sync_memory_runtime_hooks(
        self,
        *,
        emitter: EventEmitter | None,
        runtime_context: RuntimeSessionContext | None,
    ) -> None:
        self.memory_system.event_emitter = emitter
        if runtime_context is None:
            return
        act_role = runtime_context.agent_config.model_roles.act
        self.memory_system.act_model = act_role.model or runtime_context.agent_config.model or None

    def _build_skill_definitions(self) -> list[SkillDefinition]:
        raw_index = self.start_payload.get("skill_index")
        return build_runtime_skill_definitions(
            self.skill_registry,
            raw_index if isinstance(raw_index, list) else None,
            include_registry_skills=False,
        )

    def _build_sub_agent_definitions(self) -> list[SubAgentDefinition]:
        defs: list[SubAgentDefinition] = []
        for item in self.start_payload.get("sub_agents") or []:
            if not isinstance(item, dict):
                continue
            sub_id = str(item.get("id") or "").strip()
            if not sub_id:
                continue
            defs.append(
                SubAgentDefinition(
                    id=sub_id,
                    name=str(item.get("name") or sub_id),
                    description=str(item.get("description") or ""),
                    system_prompt=str(item.get("system_prompt") or ""),
                    model=str(item.get("model")) if item.get("model") else None,
                    temperature=float(item.get("temperature", 0.7)),
                    max_tokens=int(item.get("max_tokens", 4096)),
                    skills=[
                        str(skill)
                        for skill in item.get("skills", [])
                        if isinstance(skill, str) and skill.strip()
                    ],
                    mcp_servers=[],
                )
            )
        return defs

    def _register_skill_tools(self) -> None:
        logger.info(
            "skill_tool_registration_skipped",
            extra={"session_id": self.session_id, "reason": "skills_are_not_registered_as_tools"},
        )

    async def update_config(self, payload: dict[str, Any]) -> None:
        if not isinstance(payload, dict):
            return
        api_keys = payload.get("api_keys")
        if isinstance(api_keys, dict):
            existing = self.init_data.get("api_keys")
            merged = dict(existing) if isinstance(existing, dict) else {}
            for provider, key in api_keys.items():
                if isinstance(provider, str) and provider.strip() and isinstance(key, str):
                    if key.strip():
                        merged[provider] = key
                    else:
                        merged.pop(provider, None)
            self.init_data["api_keys"] = merged

        llm_config = payload.get("llm_config")
        if isinstance(llm_config, dict):
            self.init_data["llm_config"] = llm_config

        self.start_payload = {**self.start_payload, **payload}
        self.llm_provider = self._create_llm_provider()
        logger.info("semigraph_config_updated", extra={"session_id": self.session_id})

    async def get_snapshot(self) -> dict[str, Any] | None:
        try:
            return {
                "checkpoint": await self.checkpointer.get_all_for_snapshot(self.session_id),
                "short_term_memory": await self.memory_system.snapshot_short_term(self.session_id),
                "queue_state": self.get_rule_queue_snapshot(),
            }
        except Exception as exc:
            logger.warning(
                "semigraph_snapshot_failed",
                extra={"session_id": self.session_id, "error": str(exc)},
            )
            return None
