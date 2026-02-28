"""Tests for http_client builtin tool."""

import pytest

from src.skills.http_client import HttpClientTool


@pytest.mark.asyncio
async def test_http_client_requires_url_or_endpoint() -> None:
    tool = HttpClientTool()
    tool.default_base_url = ""
    result = await tool.execute(method="GET")
    assert result.success is False
    assert "url" in (result.error or "").lower()


@pytest.mark.asyncio
async def test_http_client_blocks_localhost_by_default() -> None:
    tool = HttpClientTool()
    result = await tool.execute(method="GET", url="http://localhost:8080/health")
    assert result.success is False
    assert "localhost" in (result.error or "").lower()
