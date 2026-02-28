"""Tests for web_fetch builtin tool."""

import pytest

from src.skills.web_fetch import WebFetchTool


@pytest.mark.asyncio
async def test_web_fetch_requires_url() -> None:
    tool = WebFetchTool()
    result = await tool.execute(url="")
    assert result.success is False
    assert "url" in (result.error or "").lower()


@pytest.mark.asyncio
async def test_web_fetch_blocks_localhost_by_default() -> None:
    tool = WebFetchTool()
    result = await tool.execute(url="http://127.0.0.1:3000")
    assert result.success is False
    assert "localhost" in (result.error or "").lower() or "loopback" in (result.error or "").lower()
