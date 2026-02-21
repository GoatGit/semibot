"""SubAgent Delegator implementation.

Handles delegation of tasks to SubAgents by creating isolated execution
graphs and running them within the parent agent's context.
"""

import asyncio
from typing import Any

from src.orchestrator.context import (
    AgentConfig,
    RuntimeSessionContext,
    SubAgentDefinition,
)
from src.orchestrator.graph import create_agent_graph
from src.orchestrator.state import create_initial_state
from src.mcp.bootstrap import setup_mcp_client
from src.utils.logging import get_logger

logger = get_logger(__name__)

# 最大递归委派深度
DEFAULT_MAX_DELEGATION_DEPTH = 2
# 子 Agent 执行超时（秒）
SUB_AGENT_EXECUTION_TIMEOUT = 120


class SubAgentDelegator:
    """
    SubAgent 委派器。

    负责：
    1. 验证目标子 Agent 存在且可用
    2. 构建子 Agent 的独立执行上下文（使用子 Agent 自己的 skills/MCP）
    3. 连接子 Agent 的 MCP servers
    4. 创建并���行子 Agent 的 LangGraph
    5. 清理 MCP 连接，收集结果返回给父 Agent
    """

    def __init__(
        self,
        runtime_context: RuntimeSessionContext,
        llm_provider: Any = None,
        skill_registry: Any = None,
        event_emitter: Any = None,
        max_depth: int = DEFAULT_MAX_DELEGATION_DEPTH,
        current_depth: int = 0,
    ):
        self.runtime_context = runtime_context
        self.llm_provider = llm_provider
        self.skill_registry = skill_registry
        self.event_emitter = event_emitter
        self.max_depth = max_depth
        self.current_depth = current_depth

        # 构建 sub_agent_id → SubAgentDefinition 的索引
        self._sub_agent_map: dict[str, SubAgentDefinition] = {
            sa.id: sa for sa in runtime_context.available_sub_agents
        }

    async def delegate(
        self,
        sub_agent_id: str,
        task: str,
        context: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """
        委派任务给子 Agent。

        Args:
            sub_agent_id: 目标子 Agent ID
            task: 委派的任务描述
            context: 额外上下文（memory、parent_session_id 等）

        Returns:
            {"result": ..., "agent_id": ..., "error": ...}
        """
        context = context or {}

        # 1. 深度检查
        if self.current_depth >= self.max_depth:
            logger.warning(
                "Delegation depth limit reached",
                extra={
                    "current_depth": self.current_depth,
                    "max_depth": self.max_depth,
                    "sub_agent_id": sub_agent_id,
                },
            )
            return {
                "error": f"Delegation depth limit reached ({self.max_depth})",
                "agent_id": sub_agent_id,
            }

        # 2. 验证子 Agent 存在
        sub_agent_def = self._sub_agent_map.get(sub_agent_id)
        if not sub_agent_def:
            logger.error(
                "SubAgent not found in candidate pool",
                extra={
                    "sub_agent_id": sub_agent_id,
                    "available": list(self._sub_agent_map.keys()),
                },
            )
            return {
                "error": f"SubAgent '{sub_agent_id}' not found",
                "agent_id": sub_agent_id,
            }

        logger.info(
            "Delegating to SubAgent",
            extra={
                "sub_agent_id": sub_agent_id,
                "sub_agent_name": sub_agent_def.name,
                "depth": self.current_depth + 1,
                "task_preview": task[:200],
            },
        )

        sub_mcp_client = None
        try:
            # 3. 构建子 Agent 的 AgentConfig
            sub_agent_config = AgentConfig(
                id=sub_agent_def.id,
                name=sub_agent_def.name,
                description=sub_agent_def.description,
                system_prompt=sub_agent_def.system_prompt,
                model=sub_agent_def.model,
                temperature=sub_agent_def.temperature,
                max_tokens=sub_agent_def.max_tokens,
            )

            # 4. 构建子 Agent 的 RuntimeSessionContext
            sub_runtime_context = RuntimeSessionContext(
                org_id=self.runtime_context.org_id,
                user_id=self.runtime_context.user_id,
                agent_id=sub_agent_def.id,
                session_id=self.runtime_context.session_id,
                agent_config=sub_agent_config,
                available_tools=self.runtime_context.available_tools,  # 内置工具共享
                available_mcp_servers=sub_agent_def.mcp_servers,       # 子 Agent 自己的 MCP
                available_sub_agents=[],  # 当前版本不允许再委派
            )

            # 5. 构建子 Agent 的 graph context
            sub_context: dict[str, Any] = {}
            if self.event_emitter:
                sub_context["event_emitter"] = self.event_emitter
            if self.llm_provider:
                sub_context["llm_provider"] = self.llm_provider
            if self.skill_registry:
                sub_context["skill_registry"] = self.skill_registry

            # 6. 连接子 Agent 自己的 MCP servers
            if sub_agent_def.mcp_servers:
                sub_mcp_client = await setup_mcp_client(sub_agent_def.mcp_servers)
                if sub_mcp_client:
                    for srv_def in sub_runtime_context.available_mcp_servers:
                        srv_def.is_connected = sub_mcp_client.is_connected(srv_def.id)

            # 7. 构建子 Agent 的 UnifiedActionExecutor
            from src.orchestrator.unified_executor import UnifiedActionExecutor

            sub_executor = UnifiedActionExecutor(
                runtime_context=sub_runtime_context,
                skill_registry=self.skill_registry,
                mcp_client=sub_mcp_client,
            )
            sub_context["unified_executor"] = sub_executor

            # 8. 创建子 Agent 的执行图
            sub_graph = create_agent_graph(
                context=sub_context,
                runtime_context=sub_runtime_context,
            )

            # 9. 构建初始状态
            initial_state = create_initial_state(
                session_id=self.runtime_context.session_id,
                agent_id=sub_agent_def.id,
                org_id=self.runtime_context.org_id,
                user_message=task,
                context=sub_runtime_context,
                metadata={
                    "parent_agent_id": self.runtime_context.agent_id,
                    "delegation_depth": self.current_depth + 1,
                },
            )

            # 10. 执行子 Agent（带超时）
            result = await asyncio.wait_for(
                sub_graph.ainvoke(initial_state),
                timeout=SUB_AGENT_EXECUTION_TIMEOUT,
            )

            # 11. 提取结果
            messages = result.get("messages", [])
            final_response = ""
            if messages:
                last_msg = messages[-1]
                if isinstance(last_msg, dict):
                    final_response = last_msg.get("content", "")
                else:
                    final_response = getattr(last_msg, "content", "")

            logger.info(
                "SubAgent delegation completed",
                extra={
                    "sub_agent_id": sub_agent_id,
                    "response_length": len(final_response),
                },
            )

            return {
                "result": final_response,
                "agent_id": sub_agent_id,
                "agent_name": sub_agent_def.name,
            }

        except asyncio.TimeoutError:
            logger.error(
                "SubAgent execution timed out",
                extra={
                    "sub_agent_id": sub_agent_id,
                    "timeout": SUB_AGENT_EXECUTION_TIMEOUT,
                },
            )
            return {
                "error": f"SubAgent execution timed out ({SUB_AGENT_EXECUTION_TIMEOUT}s)",
                "agent_id": sub_agent_id,
            }
        except Exception as e:
            logger.error(
                "SubAgent delegation failed",
                extra={
                    "sub_agent_id": sub_agent_id,
                    "error": str(e),
                },
            )
            return {
                "error": str(e),
                "agent_id": sub_agent_id,
            }
        finally:
            # 清理子 Agent 的 MCP 连接
            if sub_mcp_client:
                try:
                    await sub_mcp_client.close_all()
                except Exception as e:
                    logger.warning(f"Failed to close sub-agent MCP connections: {e}")
