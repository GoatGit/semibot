"""Web Search Tool implementation."""

import logging
from typing import Any

import httpx

from src.skills.base import BaseTool, ToolResult

logger = logging.getLogger(__name__)


class WebSearchTool(BaseTool):
    """
    Web search tool using various search APIs.

    Supports:
    - Tavily Search API
    - SerpAPI
    - Custom search endpoints

    Example:
        ```python
        tool = WebSearchTool(api_key="tvly-...")

        result = await tool.execute(
            query="latest AI news",
            max_results=5,
        )
        ```
    """

    def __init__(
        self,
        api_key: str | None = None,
        api_type: str = "tavily",
        timeout: int = 15,
    ):
        """
        Initialize the web search tool.

        Args:
            api_key: API key for the search service
            api_type: Type of API (tavily, serpapi, custom)
            timeout: Request timeout in seconds
        """
        self.api_key = api_key
        self.api_type = api_type
        self.timeout = timeout
        self._client: httpx.AsyncClient | None = None

    @property
    def name(self) -> str:
        return "web_search"

    @property
    def description(self) -> str:
        return "Search the web for information. Returns relevant search results with titles, URLs, and snippets."

    @property
    def parameters(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "The search query",
                },
                "max_results": {
                    "type": "integer",
                    "description": "Maximum number of results to return (default: 5)",
                    "default": 5,
                },
                "search_depth": {
                    "type": "string",
                    "enum": ["basic", "advanced"],
                    "description": "Search depth - basic for quick results, advanced for detailed",
                    "default": "basic",
                },
            },
            "required": ["query"],
        }

    async def _get_client(self) -> httpx.AsyncClient:
        """Get or create HTTP client."""
        if self._client is None:
            self._client = httpx.AsyncClient(timeout=self.timeout)
        return self._client

    async def execute(
        self,
        query: str,
        max_results: int = 5,
        search_depth: str = "basic",
        **kwargs: Any,
    ) -> ToolResult:
        """
        Execute a web search.

        Args:
            query: Search query
            max_results: Maximum results to return
            search_depth: Search depth (basic/advanced)

        Returns:
            ToolResult with search results
        """
        if not self.api_key:
            return ToolResult.error_result("API key not configured for web search")

        try:
            if self.api_type == "tavily":
                return await self._search_tavily(query, max_results, search_depth)
            elif self.api_type == "serpapi":
                return await self._search_serpapi(query, max_results)
            else:
                return ToolResult.error_result(f"Unknown API type: {self.api_type}")

        except httpx.TimeoutException:
            return ToolResult.error_result("Search request timed out")
        except Exception as e:
            logger.error(f"Web search failed: {e}")
            return ToolResult.error_result(f"Search failed: {str(e)}")

    async def _search_tavily(
        self,
        query: str,
        max_results: int,
        search_depth: str,
    ) -> ToolResult:
        """Execute search using Tavily API."""
        client = await self._get_client()

        response = await client.post(
            "https://api.tavily.com/search",
            json={
                "api_key": self.api_key,
                "query": query,
                "search_depth": search_depth,
                "max_results": max_results,
                "include_answer": True,
                "include_raw_content": False,
            },
        )

        if response.status_code != 200:
            return ToolResult.error_result(f"Tavily API error: {response.status_code}")

        data = response.json()

        # Format results
        results = []
        for item in data.get("results", []):
            results.append({
                "title": item.get("title", ""),
                "url": item.get("url", ""),
                "snippet": item.get("content", ""),
                "score": item.get("score", 0),
            })

        return ToolResult.success_result(
            result={
                "query": query,
                "answer": data.get("answer"),
                "results": results,
            },
            source="tavily",
        )

    async def _search_serpapi(
        self,
        query: str,
        max_results: int,
    ) -> ToolResult:
        """Execute search using SerpAPI."""
        client = await self._get_client()

        response = await client.get(
            "https://serpapi.com/search",
            params={
                "api_key": self.api_key,
                "q": query,
                "num": max_results,
                "engine": "google",
            },
        )

        if response.status_code != 200:
            return ToolResult.error_result(f"SerpAPI error: {response.status_code}")

        data = response.json()

        # Format results
        results = []
        for item in data.get("organic_results", []):
            results.append({
                "title": item.get("title", ""),
                "url": item.get("link", ""),
                "snippet": item.get("snippet", ""),
                "position": item.get("position", 0),
            })

        return ToolResult.success_result(
            result={
                "query": query,
                "results": results[:max_results],
            },
            source="serpapi",
        )

    async def close(self) -> None:
        """Close the HTTP client."""
        if self._client:
            await self._client.aclose()
            self._client = None
