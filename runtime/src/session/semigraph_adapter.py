from __future__ import annotations

import asyncio
import os
import time
from pathlib import Path
from typing import Any

from src.checkpoint.local_checkpointer import LocalCheckpointer
from src.llm.base import LLMConfig
from src.llm.openai_provider import OpenAIProvider
from src.mcp.client import McpClient
from src.memory.ws_memory import WSMemoryProxy
from src.mcp.bootstrap import setup_mcp_client
from src.orchestrator.context import (
    AgentConfig,
    McpServerDefinition,
    RuntimeSessionContext,
    SkillDefinition,
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
        base_url = (
            os.getenv("OPENAI_API_BASE_URL")
            or os.getenv("CUSTOM_LLM_API_BASE_URL")
            or None
        )
        if base_url and "openai.azure.com" not in base_url and not base_url.rstrip("/").endswith("/v1"):
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

    async def _run(self, payload: dict[str, Any]) -> None:
        emitter = EventEmitter()
        forward_task = asyncio.create_task(self._forward_events(emitter))
        mcp_client: McpClient | None = None

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
                available_skills=self._build_skill_definitions(),
                available_tools=self._build_tool_definitions(),
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
                    "type": "execution_complete",
                    "cancelled": True,
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
            if mcp_client:
                try:
                    await mcp_client.close_all()
                except Exception:
                    logger.warning("mcp_close_all_failed", extra={"session_id": self.session_id})

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

        registered_names = set(self.skill_registry.list_skills()) | set(self.skill_registry.list_tools())

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
            }
        except Exception as exc:
            logger.warning("semigraph_snapshot_failed", extra={"session_id": self.session_id, "error": str(exc)})
            return None
