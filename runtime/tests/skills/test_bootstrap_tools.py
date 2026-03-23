"""Tests for default builtin tool bootstrap."""

import pytest

bootstrap = pytest.importorskip("src.skills.bootstrap")
create_default_registry = bootstrap.create_default_registry


def test_default_registry_includes_core_builtin_tools() -> None:
    registry = create_default_registry()
    tools = set(registry.list_tools())
    assert "search" in tools
    assert "code_executor" in tools
    assert "file_io" in tools
    assert "semi_browser" in tools
    assert "http_client" in tools
    assert "web_fetch" in tools
    assert "text_processing" in tools
    assert "memory" in tools
    assert "control_plane" in tools
    assert "rule_authoring" in tools
    assert "pdf" not in tools
    assert "csv_xlsx" not in tools
    assert "pdf_report" not in tools
    assert "sql_query_readonly" not in tools
    assert "xlsx" not in tools
