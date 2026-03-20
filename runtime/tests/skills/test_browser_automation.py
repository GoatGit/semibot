"""Tests for builtin browser automation tool."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import pytest

from src.skills.browser_automation import BrowserAutomationTool


@dataclass
class _FakeResponse:
    status: int = 200


class _FakeKeyboard:
    async def press(self, _: str) -> None:
        return None


class _FakeLocator:
    def __init__(self, text: str) -> None:
        self._text = text
        self.first = self

    async def inner_text(self, timeout: int | None = None) -> str:
        assert timeout is None or timeout > 0
        return self._text

    async def inner_html(self, timeout: int | None = None) -> str:
        assert timeout is None or timeout > 0
        return f"<div>{self._text}</div>"


class _FakePage:
    def __init__(self) -> None:
        self.url = "about:blank"
        self.keyboard = _FakeKeyboard()

    async def goto(self, url: str, wait_until: str, timeout: int) -> _FakeResponse:
        assert wait_until in {"domcontentloaded", "load", "networkidle", "commit"}
        assert timeout > 0
        self.url = url
        return _FakeResponse(status=200)

    async def title(self) -> str:
        return "Fake Page"

    async def click(self, _: str, timeout: int) -> None:
        assert timeout > 0
        return None

    async def fill(self, _: str, __: str, timeout: int) -> None:
        assert timeout > 0
        return None

    async def press(self, _: str, __: str, timeout: int) -> None:
        assert timeout > 0
        return None

    async def wait_for_selector(self, _: str, timeout: int) -> None:
        assert timeout > 0
        return None

    async def wait_for_url(self, _: str, timeout: int) -> None:
        assert timeout > 0
        return None

    def locator(self, _: str) -> _FakeLocator:
        return _FakeLocator("sample text")

    async def evaluate(self, script: str):  # type: ignore[no-untyped-def]
        if "querySelectorAll('a[href]')" in script:
            return [{"text": "Example", "href": "https://example.com"}]
        if "innerText" in script:
            return "body text"
        return None

    async def screenshot(self, path: str, full_page: bool) -> None:
        Path(path).write_bytes(b"fake-image")
        assert isinstance(full_page, bool)

    async def content(self) -> str:
        return "<html>content</html>"


@dataclass
class _FakeSession:
    page: _FakePage
    created_at: float
    last_used_at: float


@pytest.mark.asyncio
async def test_browser_tool_blocks_localhost_open() -> None:
    tool = BrowserAutomationTool()
    result = await tool.execute(action="open", url="http://localhost:3000")
    assert result.success is False
    assert result.error is not None
    assert "blocked" in result.error.lower()


@pytest.mark.asyncio
async def test_browser_tool_open_and_extract(monkeypatch: pytest.MonkeyPatch) -> None:
    tool = BrowserAutomationTool()
    fake_session = _FakeSession(page=_FakePage(), created_at=1.0, last_used_at=1.0)

    async def _fake_ensure_session(session_id: str) -> _FakeSession:
        assert session_id == "test-session"
        return fake_session

    monkeypatch.setattr(tool, "_ensure_session", _fake_ensure_session)

    open_result = await tool.execute(
        action="open",
        session_id="test-session",
        url="https://example.com",
        wait_until="load",
    )
    assert open_result.success is True
    assert isinstance(open_result.result, dict)
    assert open_result.result["status"] == 200
    assert open_result.result["title"] == "Fake Page"

    inferred_open = await tool.execute(
        session_id="test-session",
        url="https://example.com/docs",
    )
    assert inferred_open.success is True
    assert isinstance(inferred_open.result, dict)
    assert inferred_open.result["url"] == "https://example.com/docs"

    extract_result = await tool.execute(
        action="extract_text",
        session_id="test-session",
        selector="body",
        max_chars=6,
    )
    assert extract_result.success is True
    assert isinstance(extract_result.result, dict)
    assert extract_result.result["text"] == "sample"
    assert extract_result.result["truncated"] is True


@pytest.mark.asyncio
async def test_browser_tool_screenshot(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    tool = BrowserAutomationTool()
    fake_session = _FakeSession(page=_FakePage(), created_at=1.0, last_used_at=1.0)

    async def _fake_ensure_session(_: str) -> _FakeSession:
        return fake_session

    monkeypatch.setattr(tool, "_ensure_session", _fake_ensure_session)

    result = await tool.execute(
        action="screenshot",
        session_id="shot-session",
        path=str(tmp_path / "shot.png"),
        full_page=True,
    )
    assert result.success is True
    assert isinstance(result.result, dict)
    assert Path(result.result["path"]).exists()
    assert result.result["bytes"] > 0


@pytest.mark.asyncio
async def test_browser_tool_visit_alias_maps_to_open(monkeypatch: pytest.MonkeyPatch) -> None:
    tool = BrowserAutomationTool()
    fake_session = _FakeSession(page=_FakePage(), created_at=1.0, last_used_at=1.0)

    async def _fake_ensure_session(_: str) -> _FakeSession:
        return fake_session

    monkeypatch.setattr(tool, "_ensure_session", _fake_ensure_session)

    result = await tool.execute(action="visit", url="https://example.com")
    assert result.success is True
    assert isinstance(result.result, dict)
    assert result.result["url"] == "https://example.com"
