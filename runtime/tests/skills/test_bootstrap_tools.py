"""Tests for default builtin tool bootstrap."""

from src.skills.bootstrap import create_default_registry


def test_default_registry_includes_core_builtin_tools() -> None:
    registry = create_default_registry()
    tools = set(registry.list_tools())
    assert "search" in tools
    assert "code_executor" in tools
    assert "file_io" in tools
    assert "browser_automation" in tools
    assert "http_client" in tools
    assert "web_fetch" in tools
    assert "json_transform" in tools
    assert "csv_xlsx" in tools
    assert "pdf_report" in tools
    assert "sql_query_readonly" in tools
