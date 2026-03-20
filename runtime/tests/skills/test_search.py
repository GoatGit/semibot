"""Tests for search tool compatibility behaviors."""

from __future__ import annotations

import pytest

from src.skills.search import SearchTool


class _FakeResponse:
    def __init__(self, status_code: int, payload: dict) -> None:
        self.status_code = status_code
        self._payload = payload

    def json(self) -> dict:
        return self._payload


class _FakeClient:
    def __init__(self, responses: list[_FakeResponse]) -> None:
        self.responses = list(responses)
        self.calls: list[dict] = []

    async def post(self, url: str, headers: dict | None = None, json: dict | None = None):
        self.calls.append({"url": url, "headers": headers or {}, "json": json or {}})
        return self.responses.pop(0)

    async def get(self, url: str, params: dict | None = None):
        self.calls.append({"url": url, "params": params or {}})
        return self.responses.pop(0)


def _make_tool(responses: list[_FakeResponse]) -> tuple[SearchTool, _FakeClient]:
    tool = SearchTool()
    tool._api_key = "tvly-test"
    tool._api_type = "tavily"
    tool._timeout = 15
    tool._resolve_provider = lambda: True  # type: ignore[method-assign]
    fake_client = _FakeClient(responses)
    tool._client = fake_client
    return tool, fake_client


def _tavily_result(query: str) -> _FakeResponse:
    return _FakeResponse(
        200,
        {
            "answer": f"answer:{query}",
            "images": [],
            "results": [{"title": query, "url": f"https://example.com/{query}", "content": "snippet", "score": 0.9}],
        },
    )


@pytest.mark.asyncio
async def test_search_accepts_queries_alias() -> None:
    tool, fake_client = _make_tool([_tavily_result("网易股票"), _tavily_result("网易财报")])

    result = await tool.execute(queries=["网易股票", "网易财报"])

    assert result.success is True
    assert isinstance(result.result, dict)
    assert result.result["queries"] == ["网易股票", "网易财报"]
    assert len(result.result["results"]) == 2


@pytest.mark.asyncio
async def test_search_requires_query_or_queries() -> None:
    tool, _ = _make_tool([])

    result = await tool.execute()

    assert result.success is False
    assert result.error == "Missing required parameter: queries"


@pytest.mark.asyncio
async def test_search_extract_delegates_urls() -> None:
    tool, fake_client = _make_tool(
        [
            _FakeResponse(
                200,
                {
                    "results": [{"url": "https://example.com/a", "raw_content": "# A", "images": [], "favicon": ""}],
                    "failed_results": [],
                    "response_time": 0.1,
                },
            )
        ]
    )

    result = await tool.execute(
        action="extract",
        urls=["https://example.com/a", "https://example.com/b"],
        queries=["总结要点"],
        format="markdown",
    )

    assert result.success is True
    call = fake_client.calls[0]
    assert call["url"] == "https://api.tavily.com/extract"
    assert call["json"]["query"] == "总结要点"
    assert call["json"]["format"] == "markdown"
