"""Tests for search tool compatibility behaviors."""

from __future__ import annotations

import pytest

from src.skills.base import ToolResult
from src.skills.search import SearchTool


class _FakeDelegate:
    async def execute(self, query: str, **kwargs):
        return ToolResult.success_result(
            {
                "query": query,
                "answer": f"answer:{query}",
                "results": [{"title": query, "url": f"https://example.com/{query}"}],
            }
        )


@pytest.mark.asyncio
async def test_search_accepts_queries_alias() -> None:
    tool = SearchTool()
    tool._get_delegate = lambda: _FakeDelegate()  # type: ignore[method-assign]

    result = await tool.execute(queries=["网易股票", "网易财报"])

    assert result.success is True
    assert isinstance(result.result, dict)
    assert result.result["queries"] == ["网易股票", "网易财报"]
    assert len(result.result["results"]) == 2


@pytest.mark.asyncio
async def test_search_requires_query_or_queries() -> None:
    tool = SearchTool()
    tool._get_delegate = lambda: _FakeDelegate()  # type: ignore[method-assign]

    result = await tool.execute()

    assert result.success is False
    assert result.error == "Missing required parameter: query"
