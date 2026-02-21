from __future__ import annotations

import asyncio
import time
from pathlib import Path
from typing import Any

from src.checkpoint.local_checkpointer import LocalCheckpointer
from src.llm.base import LLMConfig
from src.llm.openai_provider import OpenAIProvider
from src.mcp.client import McpClient
from src.memory.ws_memory import WSMemoryProxy
from src.orchestrator.context import AgentConfig, McpServerDefinition, RuntimeSessionContext
from src.orchestrator.graph import create_agent_graph
from src.orchestrator.state import create_initial_state
from src.orchestrator.unified_executor import UnifiedActionExecutor
from src.server.event_emitter import EventEmitter
from src.session.runtime_adapter import RuntimeAdapter
from src.skills.bootstrap import create_default_registry
from src.utils.logging import get_logger
from src.ws.client import ControlPlaneClient

logger = get_logger(__name__)


class SemiGraphAdapter(RuntimeAdapter):
    def __init__(
        self,
        client: ControlPlaneClient,
        session_id: str,
        org_id: str,
        user_id: str,
        init_data: dict[str, Any],
        start_payload: dict[str, Any],
    ) -> None:
        self.client = client
        self.session_id = session_id
        self.org_id = org_id
        self.user_id = user_id
        self.init_data = init_data
        self.start_payload = start_payload
        self._task: asyncio.Task[Any] | None = None

        self.skill_registry = create_default_registry()
        self.llm_provider = self._create_llm_provider()
        sessions_root = Path(str(self.init_data.get("memory_dir") or ".semibot/sessions"))
        self.session_root = sessions_root / self.session_id
        self.memory_system = WSMemoryProxy(self.client, str(self.session_root / "memory"))
        self.checkpointer = LocalCheckpointer(str(sessions_root))

    def _create_llm_provider(self) -> OpenAIProvider | None:
        api_keys = self.init_data.get("api_keys") or {}
        api_key = api_keys.get("openai")
        if not api_key:
            return None

        cfg = self.start_payload.get("agent_config") or {}
        model = cfg.get("model") or "gpt-4o"

        return OpenAIProvider(
            LLMConfig(
                model=model,
                api_key=api_key,
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
                        "type": "execution_error",
                        "code": "EXECUTION_CANCELLED",
                        "error": "Execution cancelled",
                    },
                )
                await self._save_checkpoint(
                    status="cancelled",
                    payload={},
                )
                await self._sync_snapshot()

    async def stop(self) -> None:
        await self.cancel()

    async def _run(self, payload: dict[str, Any]) -> None:
        emitter = EventEmitter()
        forward_task = asyncio.create_task(self._forward_events(emitter))
        mcp_client: McpClient | None = None

        try:
            agent_cfg = self.start_payload.get("agent_config") or {}
            agent_id = str(self.start_payload.get("agent_id") or self.session_id)
            mcp_servers_raw = self.start_payload.get("mcp_servers") or []

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
                available_mcp_servers=mcp_servers,
            )

            unified_executor = UnifiedActionExecutor(
                runtime_context=runtime_context,
                skill_registry=self.skill_registry,
                mcp_client=mcp_client,
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
                    "type": "execution_error",
                    "code": "EXECUTION_CANCELLED",
                    "error": "Execution cancelled",
                },
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
            await self._save_checkpoint(
                status="failed",
                payload=payload,
                error=str(exc),
            )
            await self._sync_snapshot()
        finally:
            await emitter.close()
            await forward_task

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
            logger.warning("snapshot_sync_failed", extra={"session_id": self.session_id, "error": str(exc)})
