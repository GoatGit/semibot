"""Tests for default builtin tool bootstrap."""

from src.skills.bootstrap import create_default_registry


def test_default_registry_includes_browser_automation() -> None:
    registry = create_default_registry()
    tools = set(registry.list_tools())
    assert "search" in tools
    assert "code_executor" in tools
    assert "file_io" in tools
    assert "browser_automation" in tools
