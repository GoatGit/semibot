"""Unified Action Executor - Routes and executes skills, tools, and MCP calls.

This module implements the UnifiedActionExecutor that provides a single
entry point for executing all types of actions (skills, tools, MCP tools).
It handles routing, metadata enrichment, and approval hooks.
"""

from typing import Any, Callable, Awaitable
from dataclasses import dataclass, field

from src.orchestrator.state import PlanStep, ToolCallResult
from src.orchestrator.context import RuntimeSessionContext
from src.orchestrator.capability import CapabilityGraph
from src.utils.logging import get_logger
from src.constants.config import SANDBOX_REQUIRED_TOOLS

logger = get_logger(__name__)


@dataclass
class ExecutionMetadata:
    """Metadata for action execution."""

    capability_type: str  # "skill", "tool", "mcp"
    source: str | None = None  # "local", "anthropic", "custom", "builtin"
    version: str | None = None
    mcp_server_id: str | None = None
    mcp_server_name: str | None = None
    requires_approval: bool = False
    is_high_risk: bool = False
    additional: dict[str, Any] = field(default_factory=dict)


class UnifiedActionExecutor:
    """
    Unified executor for skills, tools, and MCP calls.

    This executor provides a single entry point for all action executions.
    It handles:
    - Routing to appropriate executor (skill/tool/mcp)
    - Metadata enrichment (version, source, etc.)
    - Approval hooks for high-risk operations
    - Error handling and retry logic
    """

    def __init__(
        self,
        runtime_context: RuntimeSessionContext,
        skill_registry: Any = None,
        mcp_client: Any = None,
        approval_hook: Callable[[str, dict[str, Any], ExecutionMetadata], Awaitable[bool]] | None = None,
        audit_logger: Any = None,
    ):
        """
        Initialize the unified executor.

        Args:
            runtime_context: Runtime session context
            skill_registry: Skill registry for skill execution
            mcp_client: MCP client for MCP tool execution
            approval_hook: Optional approval hook for high-risk operations
            audit_logger: Optional audit logger for recording events
        """
        self.runtime_context = runtime_context
        self.skill_registry = skill_registry
        self.mcp_client = mcp_client
        self.approval_hook = approval_hook
        self.audit_logger = audit_logger

        # Build capability graph
        self.capability_graph = CapabilityGraph(runtime_context)
        self.capability_graph.build()

        # High-risk tools from runtime policy
        self.high_risk_tools = set(runtime_context.runtime_policy.high_risk_tools)
        if not self.high_risk_tools:
            # Fallback to default high-risk tools
            self.high_risk_tools = set(SANDBOX_REQUIRED_TOOLS)

    async def execute(
        self,
        action: PlanStep,
    ) -> ToolCallResult:
        """
        Execute an action (skill/tool/mcp).

        This is the main entry point for action execution. It:
        1. Validates the action against capability graph
        2. Determines the capability type and metadata
        3. Checks for approval if needed
        4. Routes to appropriate executor
        5. Enriches result with metadata

        Args:
            action: The action to execute

        Returns:
            ToolCallResult with execution result and metadata
        """
        tool_name = action.tool
        params = action.params

        if not tool_name:
            return ToolCallResult(
                tool_name="unknown",
                params=params,
                error="No tool name specified",
                success=False,
            )

        logger.info(
            "Executing action",
            extra={
                "session_id": self.runtime_context.session_id,
                "tool_name": tool_name,
                "action_id": action.id,
            },
        )

        # Validate action against capability graph
        if not self.capability_graph.validate_action(tool_name):
            logger.error(
                "Action not in capability graph",
                extra={
                    "session_id": self.runtime_context.session_id,
                    "tool_name": tool_name,
                },
            )
            return ToolCallResult(
                tool_name=tool_name,
                params=params,
                error=f"Action '{tool_name}' not in capability graph",
                success=False,
            )

        # Get capability and metadata
        capability = self.capability_graph.get_capability(tool_name)
        if not capability:
            return ToolCallResult(
                tool_name=tool_name,
                params=params,
                error=f"Capability '{tool_name}' not found",
                success=False,
            )

        # Build execution metadata
        metadata = self._build_metadata(capability, tool_name)

        # Log action started
        if self.audit_logger:
            await self.audit_logger.log_action_started(
                context=self.runtime_context,
                action_id=action.id,
                action_name=tool_name,
                action_params=params,
                metadata=metadata,
            )

        # Check if approval is needed
        if metadata.requires_approval and self.approval_hook:
            logger.info(
                "Requesting approval for high-risk action",
                extra={
                    "session_id": self.runtime_context.session_id,
                    "tool_name": tool_name,
                },
            )

            # Log approval requested
            if self.audit_logger:
                await self.audit_logger.log_approval_requested(
                    context=self.runtime_context,
                    action_id=action.id,
                    action_name=tool_name,
                    action_params=params,
                    metadata=metadata,
                )

            try:
                approved = await self.approval_hook(tool_name, params, metadata)
                if not approved:
                    logger.warning(
                        "Action rejected by approval hook",
                        extra={
                            "session_id": self.runtime_context.session_id,
                            "tool_name": tool_name,
                        },
                    )

                    # Log approval denied
                    if self.audit_logger:
                        await self.audit_logger.log_approval_denied(
                            context=self.runtime_context,
                            action_id=action.id,
                            action_name=tool_name,
                        )

                    # Log action rejected
                    if self.audit_logger:
                        await self.audit_logger.log_action_rejected(
                            context=self.runtime_context,
                            action_id=action.id,
                            action_name=tool_name,
                            action_params=params,
                            metadata=metadata,
                            reason="Approval denied by user",
                        )

                    return ToolCallResult(
                        tool_name=tool_name,
                        params=params,
                        error="Action rejected by approval hook",
                        success=False,
                    )
                else:
                    # Log approval granted
                    if self.audit_logger:
                        await self.audit_logger.log_approval_granted(
                            context=self.runtime_context,
                            action_id=action.id,
                            action_name=tool_name,
                        )
            except Exception as e:
                logger.error(
                    f"Approval hook failed: {e}",
                    extra={
                        "session_id": self.runtime_context.session_id,
                        "tool_name": tool_name,
                    },
                )
                return ToolCallResult(
                    tool_name=tool_name,
                    params=params,
                    error=f"Approval hook failed: {str(e)}",
                    success=False,
                )

        # Route to appropriate executor
        try:
            result = await self._route_execution(capability, tool_name, params, metadata)

            # Log action completed or failed
            if self.audit_logger:
                if result.success:
                    await self.audit_logger.log_action_completed(
                        context=self.runtime_context,
                        action_id=action.id,
                        action_name=tool_name,
                        action_params=params,
                        metadata=metadata,
                        duration_ms=result.duration_ms,
                        result=result.result,
                    )
                else:
                    await self.audit_logger.log_action_failed(
                        context=self.runtime_context,
                        action_id=action.id,
                        action_name=tool_name,
                        action_params=params,
                        metadata=metadata,
                        duration_ms=result.duration_ms,
                        error=result.error or "Unknown error",
                    )

            return result
        except Exception as e:
            logger.error(
                f"Action execution failed: {e}",
                extra={
                    "session_id": self.runtime_context.session_id,
                    "tool_name": tool_name,
                },
            )

            # Log action failed
            if self.audit_logger:
                await self.audit_logger.log_action_failed(
                    context=self.runtime_context,
                    action_id=action.id,
                    action_name=tool_name,
                    action_params=params,
                    metadata=metadata,
                    duration_ms=0,
                    error=str(e),
                )

            return ToolCallResult(
                tool_name=tool_name,
                params=params,
                error=f"Execution failed: {str(e)}",
                success=False,
            )

    def _build_metadata(self, capability: Any, tool_name: str) -> ExecutionMetadata:
        """Build execution metadata from capability."""
        is_high_risk = tool_name in self.high_risk_tools
        requires_approval = (
            is_high_risk and self.runtime_context.runtime_policy.require_approval_for_high_risk
        )

        metadata = ExecutionMetadata(
            capability_type=capability.capability_type,
            source=capability.metadata.get("source"),
            version=capability.metadata.get("version"),
            requires_approval=requires_approval,
            is_high_risk=is_high_risk,
        )

        # Add MCP-specific metadata
        if capability.capability_type == "mcp":
            metadata.mcp_server_id = capability.metadata.get("mcp_server_id")
            metadata.mcp_server_name = capability.metadata.get("mcp_server_name")

        return metadata

    async def _route_execution(
        self,
        capability: Any,
        tool_name: str,
        params: dict[str, Any],
        metadata: ExecutionMetadata,
    ) -> ToolCallResult:
        """Route execution to appropriate executor based on capability type."""
        import time

        start_time = time.time()

        if capability.capability_type == "skill":
            result = await self._execute_skill(tool_name, params)
        elif capability.capability_type == "tool":
            result = await self._execute_tool(tool_name, params)
        elif capability.capability_type == "mcp":
            result = await self._execute_mcp(tool_name, params, metadata)
        else:
            return ToolCallResult(
                tool_name=tool_name,
                params=params,
                error=f"Unknown capability type: {capability.capability_type}",
                success=False,
            )

        # Calculate duration
        duration_ms = int((time.time() - start_time) * 1000)
        result.duration_ms = duration_ms

        # Enrich result with metadata
        if not hasattr(result, 'metadata') or result.metadata is None:
            result.metadata = {}

        result.metadata.update({
            "capability_type": metadata.capability_type,
            "source": metadata.source,
            "version": metadata.version,
            "is_high_risk": metadata.is_high_risk,
        })

        if metadata.mcp_server_id:
            result.metadata["mcp_server_id"] = metadata.mcp_server_id
            result.metadata["mcp_server_name"] = metadata.mcp_server_name

        return result

    async def _execute_skill(self, tool_name: str, params: dict[str, Any]) -> ToolCallResult:
        """Execute a skill."""
        if not self.skill_registry:
            return ToolCallResult(
                tool_name=tool_name,
                params=params,
                error="Skill registry not configured",
                success=False,
            )

        logger.debug(f"Executing skill: {tool_name}")

        try:
            result = await self.skill_registry.execute(tool_name, params)
            return ToolCallResult(
                tool_name=tool_name,
                params=params,
                result=result.result if hasattr(result, 'result') else result,
                error=result.error if hasattr(result, 'error') else None,
                success=result.success if hasattr(result, 'success') else True,
                metadata=result.metadata if hasattr(result, 'metadata') else {},
            )
        except Exception as e:
            return ToolCallResult(
                tool_name=tool_name,
                params=params,
                error=str(e),
                success=False,
            )

    async def _execute_tool(self, tool_name: str, params: dict[str, Any]) -> ToolCallResult:
        """Execute a built-in tool."""
        # Built-in tools are also in skill_registry for now
        return await self._execute_skill(tool_name, params)

    async def _execute_mcp(
        self,
        tool_name: str,
        params: dict[str, Any],
        metadata: ExecutionMetadata,
    ) -> ToolCallResult:
        """Execute an MCP tool."""
        if not self.mcp_client:
            return ToolCallResult(
                tool_name=tool_name,
                params=params,
                error="MCP client not configured",
                success=False,
            )

        if not metadata.mcp_server_id:
            return ToolCallResult(
                tool_name=tool_name,
                params=params,
                error="MCP server ID not found in metadata",
                success=False,
            )

        logger.debug(
            f"Executing MCP tool: {tool_name} on server {metadata.mcp_server_name}"
        )

        try:
            # Call MCP client
            result = await self.mcp_client.call_tool(
                server_id=metadata.mcp_server_id,
                tool_name=tool_name,
                arguments=params,
            )

            return ToolCallResult(
                tool_name=tool_name,
                params=params,
                result=result,
                success=True,
            )
        except Exception as e:
            logger.error(f"MCP tool execution failed: {e}")
            return ToolCallResult(
                tool_name=tool_name,
                params=params,
                error=f"MCP execution failed: {str(e)}",
                success=False,
            )
