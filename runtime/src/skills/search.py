"""Search tool alias (always registered builtin).

Provides stable `search` tool name for planner/UI expectations.
Delegates to WebSearchTool when API key is configured.
"""

from __future__ import annotations

import os
from typing import Any

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

    def _get_delegate(self) -> WebSearchTool | None:
        if self._delegate is not None:
            return self._delegate

        tavily_key = os.getenv("TAVILY_API_KEY")
        serpapi_key = os.getenv("SERPAPI_API_KEY")
        if tavily_key:
            self._delegate = WebSearchTool(api_key=tavily_key, api_type="tavily")
        elif serpapi_key:
            self._delegate = WebSearchTool(api_key=serpapi_key, api_type="serpapi")
        return self._delegate

    async def execute(self, query: str, **kwargs: Any) -> ToolResult:
        delegate = self._get_delegate()
        if delegate is None:
            return ToolResult.error_result(
                "Search API key not configured. Set TAVILY_API_KEY or SERPAPI_API_KEY."
            )
        return await delegate.execute(query=query, **kwargs)
