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
from src.llm.base import LLMConfig
from src.llm.openai_provider import OpenAIProvider
from src.mcp.bootstrap import setup_mcp_client
from src.memory.ws_memory import WSMemoryProxy
from src.orchestrator.context import (
    AgentConfig,
    McpServerDefinition,
    RuntimeSessionContext,
    SkillDefinition,
    SubAgentDefinition,
    ToolDefinition,
)
from src.orchestrator.graph import create_agent_graph
from src.orchestrator.state import create_initial_state
from src.orchestrator.unified_executor import UnifiedActionExecutor
from src.session.runtime_adapter import RuntimeAdapter
from src.skills.bootstrap import create_default_registry
from src.skills.package_tool import PackagePythonTool
from src.utils.logging import get_logger
from src.ws.client import ControlPlaneClient
from src.ws.event_emitter import EventEmitter

logger = get_logger(__name__)


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
        org_id: str = "local",
        user_id: str = "local",
    ) -> None:
        self.client = client
        self.session_id = session_id
        self.org_id = org_id or "local"
        self.user_id = user_id or "local"
        self.init_data = init_data
        self.start_payload = start_payload
        self._task: asyncio.Task[Any] | None = None

        self.skill_registry = create_default_registry()
        self.llm_provider = self._create_llm_provider()
        sessions_root = Path(str(self.init_data.get("memory_dir") or ".semibot/sessions"))
        self.session_root = sessions_root / self.session_id
        self.memory_system = WSMemoryProxy(self.client, str(self.session_root / "memory"))
        self.checkpointer = LocalCheckpointer(str(sessions_root))
        self._event_engine: EventEngine | None = None
        self._rule_job_queue: asyncio.Queue[RuleExecutionJob] | None = None
        self._rule_workers: list[asyncio.Task[Any]] = []
        self._rule_queue_maxsize = int(os.getenv("SEMIBOT_RULE_QUEUE_MAXSIZE", "100"))
        self._rule_worker_count = int(os.getenv("SEMIBOT_RULE_WORKER_COUNT", "2"))
        self._rule_jobs_active = 0
        self._rule_jobs_accepted = 0
        self._rule_jobs_dropped = 0
        self._rule_jobs_completed = 0
        self._rule_jobs_failed = 0

    def _create_llm_provider(self) -> OpenAIProvider | None:
        api_keys = self.init_data.get("api_keys") or {}
        api_key = (
            api_keys.get("openai")
            or api_keys.get("custom")
            or os.getenv("OPENAI_API_KEY")
            or os.getenv("CUSTOM_LLM_API_KEY")
        )
        if not api_key:
            return None

        cfg = self.start_payload.get("agent_config") or {}
        model = cfg.get("model") or os.getenv("CUSTOM_LLM_MODEL_NAME") or "gpt-4o"
        base_url = os.getenv("OPENAI_API_BASE_URL") or os.getenv("CUSTOM_LLM_API_BASE_URL") or None
        if (
            base_url
            and "openai.azure.com" not in base_url
            and not base_url.rstrip("/").endswith("/v1")
        ):
            base_url = f"{base_url.rstrip('/')}/v1"

        return OpenAIProvider(
            LLMConfig(
                model=model,
                api_key=api_key,
                base_url=base_url,
                timeout=120,
            )
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
        emitter = EventEmitter()
        forward_task = asyncio.create_task(self._forward_events(emitter))
        mcp_client: Any = None
        event_engine = self._get_or_create_event_engine()
        event_engine.reload_rules()

        try:
            agent_cfg = self.start_payload.get("agent_config") or {}
            agent_id = str(self.start_payload.get("agent_id") or self.session_id)
            mcp_servers_raw = self.start_payload.get("mcp_servers") or []
            self._register_package_tools()

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
            mcp_client = await setup_mcp_client(mcp_servers)
            if mcp_client:
                for server in mcp_servers:
                    server.is_connected = mcp_client.is_connected(server.id)

            runtime_context = RuntimeSessionContext(
                org_id=self.org_id,
                user_id=self.user_id,
                agent_id=agent_id,
                session_id=self.session_id,
                agent_config=AgentConfig(
                    id=agent_id,
                    name=agent_id,
                    system_prompt=agent_cfg.get("system_prompt"),
                    model=agent_cfg.get("model"),
                    temperature=float(agent_cfg.get("temperature", 0.7)),
                    max_tokens=int(agent_cfg.get("max_tokens", 4096)),
                ),
                metadata={"event_emitter": event_engine},
                available_skills=self._build_skill_definitions(),
                available_tools=self._build_tool_definitions(),
                available_mcp_servers=mcp_servers,
                available_sub_agents=self._build_sub_agent_definitions(),
            )

            unified_executor = UnifiedActionExecutor(
                runtime_context=runtime_context,
                skill_registry=self.skill_registry,
                mcp_client=mcp_client,
                event_emitter=event_engine,
            )

            graph_context: dict[str, Any] = {
                "event_emitter": emitter,
                "skill_registry": self.skill_registry,
                "unified_executor": unified_executor,
                "memory_system": self.memory_system,
            }
            if self.llm_provider:
                graph_context["llm_provider"] = self.llm_provider

            graph = create_agent_graph(context=graph_context, runtime_context=runtime_context)

            initial_state = create_initial_state(
                session_id=self.session_id,
                agent_id=agent_id,
                org_id=self.org_id,
                user_message=str(payload.get("message", "")),
                context=runtime_context,
                history_messages=await self._resolve_history(payload),
                metadata=payload.get("metadata") or {},
            )

            await event_engine.emit(
                Event(
                    event_id=f"evt_{self.session_id}_{int(time.time() * 1000)}",
                    event_type="chat.message.received",
                    source="runtime.semigraph_adapter",
                    subject=self.session_id,
                    payload={
                        "session_id": self.session_id,
                        "agent_id": agent_id,
                        "message": str(payload.get("message", "")),
                    },
                    risk_hint="low",
                )
            )
            result = await graph.ainvoke(initial_state)

            final_response = ""
            messages = result.get("messages", [])
            if messages:
                last_msg = messages[-1]
                if isinstance(last_msg, dict):
                    final_response = str(last_msg.get("content", ""))
                else:
                    final_response = str(getattr(last_msg, "content", ""))

            await self.client.send_sse_event(
                self.session_id,
                {
                    "type": "execution_complete",
                    "final_response": final_response,
                },
            )
            await event_engine.emit(
                Event(
                    event_id=f"evt_{self.session_id}_{int(time.time() * 1000)}_done",
                    event_type="task.completed",
                    source="runtime.semigraph_adapter",
                    subject=self.session_id,
                    payload={
                        "session_id": self.session_id,
                        "agent_id": agent_id,
                        "final_response": final_response,
                    },
                    risk_hint="low",
                )
            )
            await self._save_checkpoint(
                status="completed",
                payload=payload,
                result=result,
            )
            await self._sync_snapshot()

        except asyncio.CancelledError:
            await self.client.send_sse_event(
                self.session_id,
                {
                    "type": "execution_complete",
                    "cancelled": True,
                },
            )
            await event_engine.emit(
                Event(
                    event_id=f"evt_{self.session_id}_{int(time.time() * 1000)}_cancel",
                    event_type="task.cancelled",
                    source="runtime.semigraph_adapter",
                    subject=self.session_id,
                    payload={"session_id": self.session_id},
                    risk_hint="low",
                )
            )
            await self._save_checkpoint(
                status="cancelled",
                payload=payload,
            )
            await self._sync_snapshot()
        except Exception as exc:
            logger.error("semigraph_execution_failed", exc, extra={"session_id": self.session_id})
            await self.client.send_sse_event(
                self.session_id,
                {
                    "type": "execution_error",
                    "code": "INTERNAL_ERROR",
                    "error": str(exc),
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
                    },
                    risk_hint="medium",
                )
            )
            await self._save_checkpoint(
                status="failed",
                payload=payload,
                error=str(exc),
            )
            await self._sync_snapshot()
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

    def _get_or_create_event_engine(self) -> EventEngine:
        if self._event_engine is not None:
            return self._event_engine

        async def _runtime_event_sink(event: dict[str, Any]) -> None:
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
        event_engine = self._get_or_create_event_engine()
        agent_cfg = self.start_payload.get("agent_config") or {}
        resolved_cfg = self._resolve_agent_config(agent_id, agent_cfg)

        runtime_context = RuntimeSessionContext(
            org_id=self.org_id,
            user_id=self.user_id,
            agent_id=agent_id,
            session_id=self.session_id,
            agent_config=AgentConfig(
                id=agent_id,
                name=str(resolved_cfg.get("name") or agent_id),
                system_prompt=resolved_cfg.get("system_prompt"),
                model=resolved_cfg.get("model"),
                temperature=float(resolved_cfg.get("temperature", 0.7)),
                max_tokens=int(resolved_cfg.get("max_tokens", 4096)),
            ),
            metadata={"event_emitter": event_engine},
            available_skills=self._build_skill_definitions(),
            available_tools=self._build_tool_definitions(),
            available_mcp_servers=[],
            available_sub_agents=self._build_sub_agent_definitions(),
        )

        unified_executor = UnifiedActionExecutor(
            runtime_context=runtime_context,
            skill_registry=self.skill_registry,
            mcp_client=None,
            event_emitter=event_engine,
        )

        graph_context: dict[str, Any] = {
            "skill_registry": self.skill_registry,
            "unified_executor": unified_executor,
            "memory_system": self.memory_system,
        }
        if self.llm_provider:
            graph_context["llm_provider"] = self.llm_provider

        graph = create_agent_graph(context=graph_context, runtime_context=runtime_context)
        initial_state = create_initial_state(
            session_id=self.session_id,
            agent_id=agent_id,
            org_id=self.org_id,
            user_message=message,
            context=runtime_context,
            history_messages=None,
            metadata={
                "trigger": "event_rule",
                "trace_id": trace_id,
                "event_payload": payload,
            },
        )

        result = await graph.ainvoke(initial_state)
        final_response = ""
        messages = result.get("messages", [])
        if messages:
            last_msg = messages[-1]
            if isinstance(last_msg, dict):
                final_response = str(last_msg.get("content", ""))
            else:
                final_response = str(getattr(last_msg, "content", ""))

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

    async def _forward_events(self, emitter: EventEmitter) -> None:
        async for event in emitter:
            await self.client.send_runtime_event(self.session_id, event)

    async def _resolve_history(self, payload: dict[str, Any]) -> Any:
        history = payload.get("history")
        if history:
            return history

        latest = await self.checkpointer.load_latest(self.session_id)
        if not latest:
            return None
        restored = latest.get("history")
        return restored if isinstance(restored, list) else None

    async def _save_checkpoint(
        self,
        *,
        status: str,
        payload: dict[str, Any],
        result: dict[str, Any] | None = None,
        error: str | None = None,
    ) -> None:
        messages = result.get("messages") if isinstance(result, dict) else None
        if not isinstance(messages, list):
            messages = payload.get("history")
        checkpoint = {
            "id": str(int(time.time() * 1000)),
            "session_id": self.session_id,
            "status": status,
            "history": messages if isinstance(messages, list) else [],
            "last_user_message": str(payload.get("message", "")),
            "updated_at": int(time.time()),
        }
        if error:
            checkpoint["error"] = error
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
                short_term_memory=await self.memory_system.short_term.snapshot(self.session_id),
            )
        except Exception as exc:
            logger.warning(
                "snapshot_sync_failed", extra={"session_id": self.session_id, "error": str(exc)}
            )

    def _build_tool_definitions(self) -> list[ToolDefinition]:
        tools: list[ToolDefinition] = []
        for tool_name in self.skill_registry.list_tools():
            tool = self.skill_registry.get_tool(tool_name)
            if not tool:
                continue
            tools.append(
                ToolDefinition(
                    name=tool.name,
                    description=tool.description,
                    parameters=tool.parameters,
                    metadata={"source": "builtin"},
                )
            )
        return tools

    def _build_skill_definitions(self) -> list[SkillDefinition]:
        definitions: list[SkillDefinition] = []
        raw_index = self.start_payload.get("skill_index")
        if not isinstance(raw_index, list):
            return definitions

        registered_names = set(self.skill_registry.list_skills()) | set(
            self.skill_registry.list_tools()
        )

        for item in raw_index:
            if not isinstance(item, dict):
                continue
            skill_id = str(item.get("id") or item.get("name") or "").strip()
            if not skill_id:
                continue

            if skill_id not in registered_names:
                logger.debug(
                    "skip_unregistered_skill_capability",
                    extra={"session_id": self.session_id, "skill_id": skill_id},
                )
                continue
            definitions.append(
                SkillDefinition(
                    id=skill_id,
                    name=skill_id,
                    description=str(item.get("description") or "").strip() or None,
                    version=str(item.get("version") or "").strip() or None,
                    source=str(item.get("source") or "local"),
                    schema={},
                    metadata={},
                )
            )
        return definitions

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

    def _register_package_tools(self) -> None:
        raw_index = self.start_payload.get("skill_index")
        if not isinstance(raw_index, list):
            return

        for item in raw_index:
            if not isinstance(item, dict):
                continue
            skill_name = str(item.get("id") or item.get("name") or "").strip()
            if not skill_name:
                continue
            if self.skill_registry.get_tool(skill_name) is not None:
                continue

            pkg = item.get("package")
            if not isinstance(pkg, dict):
                continue
            files = pkg.get("files")
            if not isinstance(files, list):
                continue

            script_content: str | None = None
            for f in files:
                if not isinstance(f, dict):
                    continue
                rel_path = str(f.get("path") or "")
                if rel_path == "scripts/main.py":
                    content = f.get("content")
                    if isinstance(content, str) and content.strip():
                        script_content = content
                        break

            if not script_content:
                continue

            description = str(item.get("description") or "").strip() or None
            self.skill_registry.register_tool(
                PackagePythonTool(
                    skill_name=skill_name,
                    description=description,
                    script_content=script_content,
                )
            )
            logger.info(
                "package_tool_registered",
                extra={"session_id": self.session_id, "skill_name": skill_name},
            )

    async def update_config(self, payload: dict[str, Any]) -> None:
        if not isinstance(payload, dict):
            return
        self.start_payload = {**self.start_payload, **payload}
        logger.info("semigraph_config_updated", extra={"session_id": self.session_id})

    async def get_snapshot(self) -> dict[str, Any] | None:
        try:
            return {
                "checkpoint": await self.checkpointer.get_all_for_snapshot(self.session_id),
                "short_term_memory": await self.memory_system.short_term.snapshot(self.session_id),
                "queue_state": self.get_rule_queue_snapshot(),
            }
        except Exception as exc:
            logger.warning(
                "semigraph_snapshot_failed",
                extra={"session_id": self.session_id, "error": str(exc)},
            )
            return None
