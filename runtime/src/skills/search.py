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
            "required": ["query"],
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

    async def execute(self, query: str, **kwargs: Any) -> ToolResult:
        delegate = self._get_delegate()
        if delegate is None:
            return ToolResult.error_result(
                "Search API key not configured. Please set it in Config -> Tools -> search (apiKey) or via TAVILY_API_KEY / SERPAPI_API_KEY."
            )
        return await delegate.execute(query=query, **kwargs)
