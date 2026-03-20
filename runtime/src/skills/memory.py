from __future__ import annotations

from typing import Any

from src.skills.base import BaseTool, ToolResult


def _get_memory_service(runtime_context: Any) -> Any:
    metadata = getattr(runtime_context, "metadata", None)
    return metadata.get("memory_service") if isinstance(metadata, dict) else None


class MemoryTool(BaseTool):
    @property
    def name(self) -> str:
        return "memory"

    @property
    def description(self) -> str:
        return (
            "Access session memory with one builtin tool. "
            "This tool only operates on the current runtime session memory. "
            "operation=search_long_term searches durable memories through the control plane. "
            "operation=save_long_term writes one durable memory entry. "
            "operation=get_short_term_snapshot returns the structured short-term memory snapshot. "
            "operation=compact_short_term compresses the current session short-term memory. "
            "operation=get_short_term_budget returns remaining short-term memory budget."
        )

    @property
    def parameters(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "operation": {
                    "type": "string",
                    "enum": [
                        "search_long_term",
                        "save_long_term",
                        "get_short_term_snapshot",
                        "compact_short_term",
                        "get_short_term_budget",
                    ],
                    "description": "Memory operation to run.",
                },
                "query": {
                    "type": "string",
                    "description": "Search query for operation=search_long_term.",
                },
                "limit": {
                    "type": "integer",
                    "description": "Maximum results for operation=search_long_term.",
                },
                "memory_type": {
                    "type": "string",
                    "enum": ["episodic", "semantic", "procedural"],
                    "description": "Memory type filter for operation=search_long_term or target type for operation=save_long_term.",
                },
                "content": {
                    "type": "string",
                    "description": "Memory content for operation=save_long_term.",
                },
                "importance": {
                    "type": "number",
                    "description": "Importance score 0..1 for operation=save_long_term.",
                },
                "metadata": {
                    "type": "object",
                    "description": "Optional metadata for operation=save_long_term.",
                },
                "target_chars": {
                    "type": "integer",
                    "description": "Target character budget for operation=compact_short_term.",
                },
                "instructions": {
                    "type": "string",
                    "description": "Optional compaction guidance for operation=compact_short_term.",
                },
            },
            "required": ["operation"],
        }

    async def execute(
        self,
        operation: str,
        query: str | None = None,
        limit: int | None = None,
        memory_type: str | None = None,
        content: str | None = None,
        importance: float | None = None,
        metadata: dict[str, Any] | None = None,
        target_chars: int | None = None,
        instructions: str | None = None,
        **kwargs: Any,
    ) -> ToolResult:
        runtime_context = kwargs.get("_runtime_context")
        memory_service = _get_memory_service(runtime_context)
        if memory_service is None:
            return ToolResult.error_result("memory tool requires a configured memory_service")

        session_id = getattr(runtime_context, "session_id", "")
        effective_session_id = session_id
        agent_id = getattr(runtime_context, "agent_id", "")
        runtime_metadata = getattr(runtime_context, "metadata", None)
        org_id = runtime_metadata.get("org_id") if isinstance(runtime_metadata, dict) else None

        normalized = str(operation or "").strip().lower()
        if normalized == "search_long_term":
            rows = await memory_service.search_long_term_results(
                agent_id=agent_id,
                query=str(query or "").strip(),
                limit=int(limit or 5),
                org_id=str(org_id or "").strip() or None,
                session_id=effective_session_id,
                memory_type=str(memory_type or "").strip() or None,
            )
            return ToolResult.success_result({"results": rows}, source="memory_search_long_term")

        if normalized == "save_long_term":
            normalized_content = str(content or "").strip()
            if not normalized_content:
                return ToolResult.error_result("content is required for operation=save_long_term")
            await memory_service.save_long_term(
                agent_id=agent_id,
                session_id=effective_session_id,
                org_id=str(org_id or "").strip() or None,
                content=normalized_content,
                importance=float(importance if importance is not None else 0.5),
                memory_type=str(memory_type or "semantic").strip() or "semantic",
                metadata=metadata if isinstance(metadata, dict) else {},
            )
            return ToolResult.success_result({"ok": True}, source="memory_save_long_term")

        if normalized == "get_short_term_snapshot":
            snapshot = await memory_service.snapshot_short_term(effective_session_id)
            return ToolResult.success_result(snapshot, source="memory_short_term_snapshot")

        if normalized == "compact_short_term":
            result = await memory_service.compact_short_term(
                session_id=effective_session_id,
                target_chars=target_chars,
                instructions=instructions,
            )
            return ToolResult.success_result(result, source="memory_compact_short_term")

        if normalized == "get_short_term_budget":
            budget = await memory_service.get_short_term_budget(effective_session_id)
            return ToolResult.success_result(budget.to_dict(), source="memory_short_term_budget")

        return ToolResult.error_result(
            "operation must be one of search_long_term, save_long_term, get_short_term_snapshot, compact_short_term, get_short_term_budget"
        )
