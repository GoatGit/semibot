"""Web Search Tool implementation."""

from typing import Any

import httpx

from src.skills.base import BaseTool, ToolResult
from src.utils.logging import get_logger

logger = get_logger(__name__)


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
        return (
            "Direct provider-backed web search and Tavily URL extraction. "
            "Returns structured results, snippets, optional provider answer summaries, and extracted page content."
        )

    @property
    def parameters(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "action": {
                    "type": "string",
                    "enum": ["search", "extract"],
                    "description": "Search the web or extract content from prior Tavily-discovered URLs.",
                    "default": "search",
                },
                "query": {
                    "type": "string",
                    "description": "The search query. Required for search and optional for extract reranking.",
                },
                "urls": {
                    "oneOf": [
                        {"type": "string"},
                        {"type": "array", "items": {"type": "string"}},
                    ],
                    "description": "URL or list of URLs to extract. Use only URLs returned by a prior Tavily search.",
                },
                "max_results": {
                    "type": "integer",
                    "description": "Maximum number of results to return (default: 5)",
                    "default": 5,
                },
                "search_depth": {
                    "type": "string",
                    "enum": ["basic", "advanced", "fast", "ultra-fast"],
                    "description": "Search depth controlling latency versus recall.",
                    "default": "basic",
                },
                "chunks_per_source": {
                    "type": "integer",
                    "description": "Maximum chunks per source. Tavily search supports 1-3 for advanced depth; extract supports 1-5 when query is provided.",
                },
                "topic": {
                    "type": "string",
                    "enum": ["general", "news", "finance"],
                    "description": "Search topic. Use news for latest/current events, finance for market/stock queries.",
                    "default": "general",
                },
                "days": {
                    "type": "integer",
                    "description": "Restrict to the last N days for freshness-sensitive queries.",
                },
                "time_range": {
                    "type": "string",
                    "enum": ["day", "week", "month", "year", "d", "w", "m", "y"],
                    "description": "Relative time range filter.",
                },
                "start_date": {"type": "string", "description": "Filter results after YYYY-MM-DD."},
                "end_date": {"type": "string", "description": "Filter results before YYYY-MM-DD."},
                "include_answer": {
                    "oneOf": [
                        {"type": "boolean"},
                        {"type": "string", "enum": ["basic", "advanced"]},
                    ],
                    "description": "Include Tavily answer summary.",
                    "default": True,
                },
                "include_raw_content": {
                    "oneOf": [
                        {"type": "boolean"},
                        {"type": "string", "enum": ["markdown", "text"]},
                    ],
                    "description": "Include cleaned source content.",
                    "default": False,
                },
                "include_images": {"type": "boolean", "description": "Include images when supported.", "default": False},
                "include_image_descriptions": {
                    "type": "boolean",
                    "description": "Include image descriptions when include_images=true.",
                    "default": False,
                },
                "include_favicon": {"type": "boolean", "description": "Include favicon URLs when supported.", "default": False},
                "country": {"type": "string", "description": "Boost general search results from a specific country."},
                "extract_depth": {
                    "type": "string",
                    "enum": ["basic", "advanced"],
                    "description": "Tavily extract depth.",
                    "default": "basic",
                },
                "format": {
                    "type": "string",
                    "enum": ["markdown", "text"],
                    "description": "Output format for extract raw content.",
                    "default": "markdown",
                },
                "timeout_ms": {
                    "type": "integer",
                    "description": "Per-request timeout for extract in milliseconds.",
                },
                "include_usage": {
                    "type": "boolean",
                    "description": "Include provider usage metadata when available.",
                    "default": False,
                },
                "include_domains": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "Domains to include in Tavily search results.",
                },
                "exclude_domains": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "Domains to exclude from Tavily search results.",
                },
            },
            "required": [],
        }

    async def _get_client(self) -> httpx.AsyncClient:
        """Get or create HTTP client."""
        if self._client is None:
            self._client = httpx.AsyncClient(timeout=self.timeout)
        return self._client

    async def execute(
        self,
        query: str = "",
        action: str = "search",
        max_results: int = 5,
        search_depth: str = "basic",
        topic: str = "general",
        days: int | None = None,
        include_domains: list[str] | None = None,
        exclude_domains: list[str] | None = None,
        urls: str | list[str] | None = None,
        chunks_per_source: int | None = None,
        time_range: str | None = None,
        start_date: str | None = None,
        end_date: str | None = None,
        include_answer: bool | str = True,
        include_raw_content: bool | str = False,
        include_images: bool = False,
        include_image_descriptions: bool = False,
        include_favicon: bool = False,
        country: str | None = None,
        extract_depth: str = "basic",
        format: str = "markdown",
        timeout: int | float | None = None,
        timeout_ms: int | None = None,
        include_usage: bool = False,
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
            extract_timeout_seconds: int | float | None = timeout
            if isinstance(timeout_ms, int) and timeout_ms > 0:
                extract_timeout_seconds = max(1.0, float(timeout_ms) / 1000.0)
            normalized_action = str(action or "search").strip().lower() or "search"
            if self.api_type == "tavily":
                if normalized_action == "extract":
                    return await self._extract_tavily(
                        urls=urls,
                        query=query,
                        chunks_per_source=chunks_per_source,
                        extract_depth=extract_depth,
                        include_images=include_images,
                        include_favicon=include_favicon,
                        format=format,
                        timeout=extract_timeout_seconds,
                        include_usage=include_usage,
                    )
                return await self._search_tavily(
                    query=query,
                    max_results=max_results,
                    search_depth=search_depth,
                    topic=topic,
                    days=days,
                    include_domains=include_domains,
                    exclude_domains=exclude_domains,
                    chunks_per_source=chunks_per_source,
                    time_range=time_range,
                    start_date=start_date,
                    end_date=end_date,
                    include_answer=include_answer,
                    include_raw_content=include_raw_content,
                    include_images=include_images,
                    include_image_descriptions=include_image_descriptions,
                    include_favicon=include_favicon,
                    country=country,
                    include_usage=include_usage,
                )
            elif self.api_type == "serpapi":
                if normalized_action == "extract":
                    return ToolResult.error_result("Extract action is only available with Tavily search.")
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
        topic: str = "general",
        days: int | None = None,
        include_domains: list[str] | None = None,
        exclude_domains: list[str] | None = None,
        chunks_per_source: int | None = None,
        time_range: str | None = None,
        start_date: str | None = None,
        end_date: str | None = None,
        include_answer: bool | str = True,
        include_raw_content: bool | str = False,
        include_images: bool = False,
        include_image_descriptions: bool = False,
        include_favicon: bool = False,
        country: str | None = None,
        include_usage: bool = False,
    ) -> ToolResult:
        """Execute search using Tavily API."""
        client = await self._get_client()

        payload: dict[str, Any] = {
            "query": query,
            "search_depth": search_depth,
            "max_results": max_results,
            "include_answer": include_answer,
            "include_raw_content": include_raw_content,
            "topic": str(topic).lower() if str(topic).lower() in {"general", "news", "finance"} else "general",
            "include_images": include_images,
            "include_favicon": include_favicon,
            "include_usage": include_usage,
        }
        if isinstance(days, int) and days > 0:
            payload["days"] = days
        if include_domains:
            payload["include_domains"] = include_domains
        if exclude_domains:
            payload["exclude_domains"] = exclude_domains
        if isinstance(chunks_per_source, int) and chunks_per_source > 0:
            payload["chunks_per_source"] = chunks_per_source
        if isinstance(time_range, str) and time_range.strip():
            payload["time_range"] = time_range.strip()
        if isinstance(start_date, str) and start_date.strip():
            payload["start_date"] = start_date.strip()
        if isinstance(end_date, str) and end_date.strip():
            payload["end_date"] = end_date.strip()
        if include_images:
            payload["include_image_descriptions"] = include_image_descriptions
        if payload["topic"] == "general" and isinstance(country, str) and country.strip():
            payload["country"] = country.strip().lower()

        response = await client.post(
            "https://api.tavily.com/search",
            headers={"Authorization": f"Bearer {self.api_key}"},
            json=payload,
        )

        if response.status_code != 200:
            return ToolResult.error_result(f"Tavily API error: {response.status_code}")

        data = response.json()
        if not data.get("results"):
            # Fallback once with a relaxed query and without domain filters.
            relaxed_query = (query.split("。", 1)[0] if "。" in query else query).strip()
            relaxed_payload = {
                "query": relaxed_query[:200],
                "search_depth": "basic",
                "max_results": max_results,
                "include_answer": include_answer,
                "include_raw_content": include_raw_content,
                "topic": payload["topic"],
                "include_images": include_images,
                "include_favicon": include_favicon,
                "include_usage": include_usage,
            }
            if isinstance(days, int) and days > 0:
                relaxed_payload["days"] = days
            response = await client.post(
                "https://api.tavily.com/search",
                headers={"Authorization": f"Bearer {self.api_key}"},
                json=relaxed_payload,
            )
            if response.status_code == 200:
                data = response.json()

        # Format results
        results = []
        for item in data.get("results", []):
            results.append({
                "title": item.get("title", ""),
                "url": item.get("url", ""),
                "snippet": item.get("content", ""),
                "score": item.get("score", 0),
                "raw_content": item.get("raw_content", ""),
                "favicon": item.get("favicon", ""),
            })

        return ToolResult.success_result(
            result={
                "query": query,
                "answer": data.get("answer"),
                "images": data.get("images", []),
                "results": results,
                "response_time": data.get("response_time"),
                "auto_parameters": data.get("auto_parameters"),
                "request_id": data.get("request_id"),
                "usage": data.get("usage") if include_usage else None,
            },
            source="tavily",
            action="search",
        )

    async def _extract_tavily(
        self,
        *,
        urls: str | list[str] | None,
        query: str | None = None,
        chunks_per_source: int | None = None,
        extract_depth: str = "basic",
        include_images: bool = False,
        include_favicon: bool = False,
        format: str = "markdown",
        timeout: int | float | None = None,
        include_usage: bool = False,
    ) -> ToolResult:
        client = await self._get_client()
        if isinstance(urls, str):
            normalized_urls = [urls.strip()] if urls.strip() else []
        elif isinstance(urls, list):
            normalized_urls = [str(item).strip() for item in urls if str(item).strip()]
        else:
            normalized_urls = []
        if not normalized_urls:
            return ToolResult.error_result("Missing required parameter: urls")

        payload: dict[str, Any] = {
            "urls": normalized_urls if len(normalized_urls) > 1 else normalized_urls[0],
            "extract_depth": str(extract_depth or "basic").strip().lower() or "basic",
            "include_images": bool(include_images),
            "include_favicon": bool(include_favicon),
            "format": "text" if str(format).strip().lower() == "text" else "markdown",
            "include_usage": bool(include_usage),
        }
        if isinstance(query, str) and query.strip():
            payload["query"] = query.strip()
        if isinstance(chunks_per_source, int) and chunks_per_source > 0:
            payload["chunks_per_source"] = chunks_per_source
        if isinstance(timeout, (int, float)) and 1 <= float(timeout) <= 60:
            payload["timeout"] = float(timeout)

        response = await client.post(
            "https://api.tavily.com/extract",
            headers={"Authorization": f"Bearer {self.api_key}"},
            json=payload,
        )

        if response.status_code != 200:
            return ToolResult.error_result(f"Tavily Extract API error: {response.status_code}")

        data = response.json()
        results = []
        for item in data.get("results", []):
            if not isinstance(item, dict):
                continue
            results.append(
                {
                    "url": item.get("url", ""),
                    "raw_content": item.get("raw_content", ""),
                    "images": item.get("images", []),
                    "favicon": item.get("favicon", ""),
                }
            )

        return ToolResult.success_result(
            result={
                "query": query,
                "urls": normalized_urls,
                "results": results,
                "failed_results": data.get("failed_results", []),
                "response_time": data.get("response_time"),
                "request_id": data.get("request_id"),
                "usage": data.get("usage") if include_usage else None,
            },
            source="tavily",
            action="extract",
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
