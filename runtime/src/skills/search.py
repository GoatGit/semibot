"""Search tool (always registered builtin).

Provides stable `search` tool name for planner/UI expectations.
Supports Tavily Search API and SerpAPI directly.
"""

from __future__ import annotations

import asyncio
import os
from typing import Any

import httpx

from src.server.config_store import RuntimeConfigStore
from src.skills.base import BaseTool, ToolResult
from src.utils.logging import get_logger

logger = get_logger(__name__)


class SearchTool(BaseTool):
    def __init__(self) -> None:
        self._api_key: str | None = None
        self._api_type: str = "tavily"
        self._timeout: int = 15
        self._client: httpx.AsyncClient | None = None

    @property
    def name(self) -> str:
        return "search"

    @property
    def description(self) -> str:
        return (
            "Web search tool. Pass one or more search queries via the `queries` array. "
            "Supports Tavily URL extraction via action=extract."
        )

    @property
    def parameters(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "queries": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "One or more search queries. Always use this parameter, even for a single query.",
                },
                "action": {
                    "type": "string",
                    "enum": ["search", "extract"],
                    "description": "Search the web or extract content from prior Tavily URLs.",
                    "default": "search",
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
                    "description": "Maximum number of results",
                    "default": 5,
                },
                "search_depth": {
                    "type": "string",
                    "enum": ["basic", "advanced", "fast", "ultra-fast"],
                    "description": "Provider search depth controlling latency versus recall.",
                    "default": "basic",
                },
                "chunks_per_source": {"type": "integer", "description": "Maximum chunks per source when the provider supports chunked extraction."},
                "topic": {
                    "type": "string",
                    "enum": ["general", "news", "finance"],
                    "default": "general",
                },
                "days": {
                    "type": "integer",
                    "description": "Restrict to the last N days for freshness-sensitive queries.",
                },
                "time_range": {
                    "type": "string",
                    "enum": ["day", "week", "month", "year", "d", "w", "m", "y"],
                },
                "start_date": {"type": "string", "description": "Absolute start date filter in YYYY-MM-DD format."},
                "end_date": {"type": "string", "description": "Absolute end date filter in YYYY-MM-DD format."},
                "include_answer": {
                    "oneOf": [
                        {"type": "boolean"},
                        {"type": "string", "enum": ["basic", "advanced"]},
                    ],
                    "description": "Whether to include the provider answer summary when supported.",
                },
                "include_raw_content": {
                    "oneOf": [
                        {"type": "boolean"},
                        {"type": "string", "enum": ["markdown", "text"]},
                    ],
                    "description": "Whether to include cleaned source content when supported.",
                },
                "include_images": {"type": "boolean", "description": "Include provider image results when supported."},
                "include_image_descriptions": {"type": "boolean", "description": "Include image descriptions when images are returned."},
                "include_favicon": {"type": "boolean", "description": "Include favicon URLs when supported."},
                "country": {"type": "string", "description": "Country hint for provider ranking."},
                "extract_depth": {
                    "type": "string",
                    "enum": ["basic", "advanced"],
                    "description": "Extraction depth for action=extract.",
                    "default": "basic",
                },
                "format": {
                    "type": "string",
                    "enum": ["markdown", "text"],
                    "description": "Output format for extracted raw content.",
                    "default": "markdown",
                },
                "timeout_ms": {"type": "integer", "description": "Per-request timeout in milliseconds."},
                "include_usage": {"type": "boolean", "description": "Include provider usage metadata when available."},
                "include_domains": {"type": "array", "items": {"type": "string"}, "description": "Domains to include in search results."},
                "exclude_domains": {"type": "array", "items": {"type": "string"}, "description": "Domains to exclude from search results."},
            },
            "required": ["queries"],
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

        cfg_api_key = cfg.get("apiKey")
        cfg_tavily_key = cfg.get("tavilyApiKey")
        cfg_serpapi_key = cfg.get("serpapiApiKey")

        api_type = str(cfg.get("provider") or cfg.get("apiType") or "").strip().lower()
        timeout_raw = cfg.get("timeout")
        timeout_seconds = 15
        if isinstance(timeout_raw, (int, float)) and timeout_raw > 0:
            timeout_seconds = max(1, int(timeout_raw / 1000) if timeout_raw > 1000 else int(timeout_raw))

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

    def _resolve_provider(self) -> bool:
        """Resolve API config and return True if a key is available."""
        api_key, api_type, timeout_seconds = self._resolve_delegate_config()
        if not api_key:
            return False
        self._api_key = api_key
        self._api_type = api_type
        self._timeout = timeout_seconds
        return True

    async def _get_client(self) -> httpx.AsyncClient:
        if self._client is None:
            self._client = httpx.AsyncClient(timeout=self._timeout)
        return self._client

    def _normalize_queries(self, queries: Any) -> list[str]:
        """Normalize queries input. Only accepts `queries` array."""
        normalized: list[str] = []
        if isinstance(queries, list):
            for item in queries:
                if not isinstance(item, str):
                    continue
                q = item.strip()
                if q and q not in normalized:
                    normalized.append(q)
        return normalized[:12]

    async def execute(self, queries: Any = None, action: str = "search", urls: Any = None, **kwargs: Any) -> ToolResult:
        # Always pop legacy `query` from kwargs to prevent double-passing to _execute_single
        legacy_query = kwargs.pop("query", None)
        if legacy_query and not queries:
            if isinstance(legacy_query, str) and legacy_query.strip():
                queries = [legacy_query.strip()]
                logger.info(f"[search] Auto-converted legacy `query` param to queries array: {queries}")
            elif isinstance(legacy_query, list):
                queries = legacy_query
                logger.info(f"[search] Auto-converted legacy `query` list param to queries: {queries}")

        if not self._resolve_provider():
            return ToolResult.error_result(
                "Search API key not configured. Please set it in Config -> Tools -> search (apiKey)."
            )

        try:
            normalized_action = str(action or "search").strip().lower() or "search"
            if normalized_action == "extract":
                extract_query = ""
                if isinstance(queries, list) and queries:
                    extract_query = str(queries[0] or "").strip()
                return await self._extract_tavily_action(query=extract_query, urls=urls, **kwargs)

            normalized_queries = self._normalize_queries(queries)
            if not normalized_queries:
                return ToolResult.error_result("Missing required parameter: queries")

            if len(normalized_queries) == 1:
                return await self._execute_single(query=normalized_queries[0], **kwargs)

            return await self._execute_batch(normalized_queries, **kwargs)
        except httpx.TimeoutException:
            return ToolResult.error_result("Search request timed out")
        except Exception as e:
            logger.error(f"Search failed: {e}")
            return ToolResult.error_result(f"Search failed: {str(e)}")

    async def _execute_single(self, query: str, **kwargs: Any) -> ToolResult:
        if self._api_type == "tavily":
            return await self._search_tavily(query=query, **kwargs)
        if self._api_type == "serpapi":
            return await self._search_serpapi(query=query, max_results=kwargs.get("max_results", 5))
        return ToolResult.error_result(f"Unknown API type: {self._api_type}")

    async def _execute_batch(self, normalized_queries: list[str], **kwargs: Any) -> ToolResult:
        merged_results: list[dict[str, Any]] = []
        per_query: list[dict[str, Any]] = []
        errors: list[str] = []

        # Parallel execution with concurrency limit to avoid API rate-limiting.
        _BATCH_CONCURRENCY = 4
        semaphore = asyncio.Semaphore(_BATCH_CONCURRENCY)

        async def _run_one(q: str) -> tuple[str, ToolResult]:
            async with semaphore:
                return q, await self._execute_single(query=q, **kwargs)

        raw_results = await asyncio.gather(
            *[_run_one(q) for q in normalized_queries],
            return_exceptions=True,
        )

        # Assemble results in original query order.
        for item in raw_results:
            if isinstance(item, BaseException):
                errors.append(str(item)[:200])
                continue
            q, result = item
            if not result.success:
                errors.append(f"{q}: {result.error or 'unknown error'}")
                continue

            payload = result.result if isinstance(result.result, dict) else {"raw": result.result}
            rows = payload.get("results", []) if isinstance(payload, dict) else []
            if isinstance(rows, list):
                for row in rows:
                    if isinstance(row, dict):
                        merged_results.append(dict(row))

            per_query.append(
                {
                    "term": q,
                    "answer": payload.get("answer") if isinstance(payload, dict) else None,
                    "results_count": len(rows) if isinstance(rows, list) else 0,
                }
            )

        if not per_query:
            return ToolResult.error_result("; ".join(errors) if errors else "Search failed")

        # Put batch_summary and per_query BEFORE the large results array so that
        # the 300-char backfeed truncation still shows the LLM that all queries
        # were searched, preventing redundant follow-up single-query searches.
        return ToolResult.success_result(
            result={
                "batch_summary": f"{len(per_query)} queries searched, {len(merged_results)} results total",
                "per_query": per_query,
                "queries": normalized_queries,
                "results": merged_results,
                "errors": errors,
            },
            source="search-batch",
            mode="batch",
            query_count=len(normalized_queries),
        )

    async def _extract_tavily_action(self, *, query: str, urls: Any, **kwargs: Any) -> ToolResult:
        if self._api_type != "tavily":
            return ToolResult.error_result("Extract action is only available with Tavily search.")
        timeout_ms = kwargs.get("timeout_ms")
        extract_timeout: int | float | None = kwargs.get("timeout")
        if isinstance(timeout_ms, int) and timeout_ms > 0:
            extract_timeout = max(1.0, float(timeout_ms) / 1000.0)
        return await self._extract_tavily(
            urls=urls,
            query=query,
            chunks_per_source=kwargs.get("chunks_per_source"),
            extract_depth=kwargs.get("extract_depth", "basic"),
            include_images=kwargs.get("include_images", False),
            include_favicon=kwargs.get("include_favicon", False),
            format=kwargs.get("format", "markdown"),
            timeout=extract_timeout,
            include_usage=kwargs.get("include_usage", False),
        )

    async def _search_tavily(
        self,
        query: str = "",
        max_results: int = 5,
        search_depth: str = "basic",
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
        **_: Any,
    ) -> ToolResult:
        client = await self._get_client()

        # Sanitize parameters — LLM may pass unexpected types
        if search_depth not in ("basic", "advanced"):
            search_depth = "basic"
        try:
            max_results = int(max_results)
            max_results = max(1, min(max_results, 20))
        except (TypeError, ValueError):
            max_results = 5

        # Tavily requires include_answer to be True, False, "basic", or "advanced"
        _VALID_INCLUDE_ANSWER = {True, False, "basic", "advanced"}
        if include_answer not in _VALID_INCLUDE_ANSWER:
            if isinstance(include_answer, str) and include_answer.lower() in ("true", "yes", "1"):
                include_answer = True
            elif isinstance(include_answer, str) and include_answer.lower() in ("false", "no", "0"):
                include_answer = False
            else:
                include_answer = True
        if include_raw_content not in (True, False, "markdown", "text"):
            if isinstance(include_raw_content, str):
                normalized_raw_content = include_raw_content.strip().lower()
                if normalized_raw_content in ("true", "yes", "1"):
                    include_raw_content = True
                elif normalized_raw_content in ("false", "no", "0"):
                    include_raw_content = False
                elif normalized_raw_content in ("markdown", "text"):
                    include_raw_content = normalized_raw_content
                else:
                    include_raw_content = False
            else:
                include_raw_content = False

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
            headers={"Authorization": f"Bearer {self._api_key}"},
            json=payload,
        )

        if response.status_code != 200:
            body = ""
            try:
                body = response.text[:500]
            except Exception:
                pass
            logger.warning(
                "tavily_api_error",
                extra={"status": response.status_code, "body": body, "query": query},
            )
            return ToolResult.error_result(
                f"Tavily API error {response.status_code}: {body[:200]}"
            )

        data = response.json()
        if not data.get("results"):
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
                headers={"Authorization": f"Bearer {self._api_key}"},
                json=relaxed_payload,
            )
            if response.status_code == 200:
                data = response.json()
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
            headers={"Authorization": f"Bearer {self._api_key}"},
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

    async def _search_serpapi(self, query: str, max_results: int = 5) -> ToolResult:
        client = await self._get_client()

        response = await client.get(
            "https://serpapi.com/search",
            params={
                "api_key": self._api_key,
                "q": query,
                "num": max_results,
                "engine": "google",
            },
        )

        if response.status_code != 200:
            return ToolResult.error_result(f"SerpAPI error: {response.status_code}")

        data = response.json()
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
                "results": results[:max_results],
            },
            source="serpapi",
        )

    async def close(self) -> None:
        if self._client:
            await self._client.aclose()
            self._client = None
