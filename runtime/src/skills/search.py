"""Search tool alias (always registered builtin).

Provides stable `search` tool name for planner/UI expectations.
Delegates to WebSearchTool when API key is configured.
"""

from __future__ import annotations

import os
from typing import Any

from src.server.config_store import RuntimeConfigStore
from src.skills.base import BaseTool, ToolResult
from src.skills.web_search import WebSearchTool


class SearchTool(BaseTool):
    def __init__(self) -> None:
        self._delegate: WebSearchTool | None = None

    @property
    def name(self) -> str:
        return "search"

    @property
    def description(self) -> str:
        return "Search the web for latest information and return titles, URLs, snippets."

    @property
    def parameters(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "Search query"},
                "queries": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "Batch search queries. Alias-compatible with older plans.",
                },
                "max_results": {
                    "type": "integer",
                    "description": "Maximum number of results",
                    "default": 5,
                },
                "search_depth": {
                    "type": "string",
                    "enum": ["basic", "advanced"],
                    "default": "basic",
                },
                "topic": {
                    "type": "string",
                    "enum": ["general", "news"],
                    "default": "general",
                },
                "days": {
                    "type": "integer",
                    "description": "Restrict to the last N days for freshness-sensitive queries.",
                },
            },
            "required": [],
        }

    def _resolve_config_from_store(self) -> dict[str, Any]:
        try:
            store = RuntimeConfigStore(db_path=os.getenv("SEMIBOT_EVENTS_DB_PATH"))
            item = store.get_tool_by_name("search")
            config = item.get("config") if isinstance(item, dict) else {}
            return config if isinstance(config, dict) else {}
        except Exception:
            return {}

    def _resolve_delegate_config(self) -> tuple[str | None, str, int]:
        cfg = self._resolve_config_from_store()

        env_tavily_key = os.getenv("TAVILY_API_KEY")
        env_serpapi_key = os.getenv("SERPAPI_API_KEY")
        cfg_api_key = cfg.get("apiKey")
        cfg_tavily_key = cfg.get("tavilyApiKey")
        cfg_serpapi_key = cfg.get("serpapiApiKey")

        api_type = str(cfg.get("provider") or cfg.get("apiType") or "").strip().lower()
        timeout_raw = cfg.get("timeout")
        timeout_seconds = 15
        if isinstance(timeout_raw, (int, float)) and timeout_raw > 0:
            timeout_seconds = max(1, int(timeout_raw / 1000) if timeout_raw > 1000 else int(timeout_raw))

        # Environment variables have highest priority.
        if env_tavily_key:
            return env_tavily_key, "tavily", timeout_seconds
        if env_serpapi_key:
            return env_serpapi_key, "serpapi", timeout_seconds

        # Runtime tool config fallback.
        if api_type not in {"tavily", "serpapi"}:
            if cfg_serpapi_key:
                api_type = "serpapi"
            else:
                api_type = "tavily"

        if api_type == "serpapi":
            key = str(cfg_serpapi_key or cfg_api_key or "").strip() or None
            return key, "serpapi", timeout_seconds
        key = str(cfg_tavily_key or cfg_api_key or "").strip() or None
        return key, "tavily", timeout_seconds

    def _get_delegate(self) -> WebSearchTool | None:
        api_key, api_type, timeout_seconds = self._resolve_delegate_config()
        if not api_key:
            self._delegate = None
            return None
        self._delegate = WebSearchTool(api_key=api_key, api_type=api_type, timeout=timeout_seconds)
        return self._delegate

    def _normalize_queries(self, query: str | None, queries: Any) -> list[str]:
        normalized: list[str] = []
        if isinstance(query, str) and query.strip():
            normalized.append(query.strip())
        if isinstance(queries, list):
            for item in queries:
                if not isinstance(item, str):
                    continue
                q = item.strip()
                if not q:
                    continue
                if q not in normalized:
                    normalized.append(q)
        # Keep bounded to avoid accidental large fan-out from malformed plans.
        return normalized[:12]

    async def execute(self, query: str | None = None, queries: Any = None, **kwargs: Any) -> ToolResult:
        delegate = self._get_delegate()
        if delegate is None:
            return ToolResult.error_result(
                "Search API key not configured. Please set it in Config -> Tools -> search (apiKey) or via TAVILY_API_KEY / SERPAPI_API_KEY."
            )

        normalized_queries = self._normalize_queries(query, queries)
        if not normalized_queries:
            return ToolResult.error_result("Missing required parameter: query")

        if len(normalized_queries) == 1:
            return await delegate.execute(query=normalized_queries[0], **kwargs)

        merged_results: list[dict[str, Any]] = []
        per_query: list[dict[str, Any]] = []
        errors: list[str] = []
        for q in normalized_queries:
            result = await delegate.execute(query=q, **kwargs)
            if not result.success:
                errors.append(f"{q}: {result.error or 'unknown error'}")
                continue

            payload = result.result if isinstance(result.result, dict) else {"raw": result.result}
            rows = payload.get("results", []) if isinstance(payload, dict) else []
            if isinstance(rows, list):
                for row in rows:
                    if isinstance(row, dict):
                        enriched = dict(row)
                        enriched.setdefault("query", q)
                        merged_results.append(enriched)

            per_query.append({
                "query": q,
                "answer": payload.get("answer") if isinstance(payload, dict) else None,
                "results_count": len(rows) if isinstance(rows, list) else 0,
            })

        if not per_query:
            return ToolResult.error_result("; ".join(errors) if errors else "Search failed")

        return ToolResult.success_result(
            result={
                "query": normalized_queries[0],
                "queries": normalized_queries,
                "results": merged_results,
                "per_query": per_query,
                "errors": errors,
            },
            source="search-batch",
            mode="batch",
            query_count=len(normalized_queries),
        )
