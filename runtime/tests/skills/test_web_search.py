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
        self.responses = responses
        self.calls: list[dict] = []

    async def post(self, url: str, headers: dict | None = None, json: dict | None = None):
        self.calls.append({"url": url, "headers": headers or {}, "json": json or {}})
        return self.responses.pop(0)


def _make_tool(api_key: str = "tvly-test", api_type: str = "tavily") -> SearchTool:
    tool = SearchTool()
    tool._api_key = api_key
    tool._api_type = api_type
    tool._timeout = 15
    tool._resolve_provider = lambda: True  # type: ignore[method-assign]
    return tool


@pytest.mark.asyncio
async def test_search_tavily_uses_authorization_header_and_extended_payload() -> None:
    tool = _make_tool()
    fake_client = _FakeClient(
        [
            _FakeResponse(
                200,
                {
                    "answer": "ok",
                    "images": [],
                    "results": [
                        {
                            "title": "A",
                            "url": "https://a",
                            "content": "snippet",
                            "score": 0.8,
                            "favicon": "https://a/favicon.ico",
                        }
                    ],
                    "response_time": "0.42",
                    "auto_parameters": {"topic": "finance", "search_depth": "advanced"},
                    "usage": {"credits": 1},
                    "request_id": "req-1",
                },
            )
        ]
    )
    tool._client = fake_client

    result = await tool.execute(
        action="search",
        queries=["PDD stock"],
        search_depth="advanced",
        chunks_per_source=3,
        topic="finance",
        time_range="month",
        start_date="2026-03-01",
        end_date="2026-03-11",
        include_answer="advanced",
        include_raw_content="markdown",
        include_images=True,
        include_image_descriptions=True,
        include_favicon=True,
        include_usage=True,
        max_results=6,
    )

    assert result.success is True
    call = fake_client.calls[0]
    assert call["url"] == "https://api.tavily.com/search"
    assert call["headers"]["Authorization"] == "Bearer tvly-test"
    assert call["json"]["topic"] == "finance"
    assert call["json"]["include_answer"] == "advanced"
    assert call["json"]["include_raw_content"] == "markdown"
    assert call["json"]["include_image_descriptions"] is True
    assert (result.result or {})["request_id"] == "req-1"


@pytest.mark.asyncio
async def test_search_tavily_extract_posts_extract_payload() -> None:
    tool = _make_tool()
    fake_client = _FakeClient(
        [
            _FakeResponse(
                200,
                {
                    "results": [
                        {
                            "url": "https://example.com/a",
                            "raw_content": "# A",
                            "images": [],
                            "favicon": "https://example.com/favicon.ico",
                        }
                    ],
                    "failed_results": [],
                    "response_time": 0.2,
                    "usage": {"credits": 1},
                    "request_id": "req-extract",
                },
            )
        ]
    )
    tool._client = fake_client

    result = await tool.execute(
        action="extract",
        urls=["https://example.com/a"],
        queries=["总结重点"],
        chunks_per_source=4,
        extract_depth="advanced",
        include_images=True,
        include_favicon=True,
        format="markdown",
        timeout=12,
        include_usage=True,
    )

    assert result.success is True
    call = fake_client.calls[0]
    assert call["url"] == "https://api.tavily.com/extract"
    assert call["headers"]["Authorization"] == "Bearer tvly-test"
    assert call["json"]["urls"] == "https://example.com/a"
    assert call["json"]["query"] == "总结重点"
    assert call["json"]["chunks_per_source"] == 4
    assert call["json"]["extract_depth"] == "advanced"
    assert call["json"]["format"] == "markdown"
    assert (result.result or {})["request_id"] == "req-extract"
