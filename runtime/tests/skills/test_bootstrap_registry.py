import pytest


def test_default_registry_exposes_search_but_not_web_search() -> None:
    bootstrap = pytest.importorskip("src.skills.bootstrap")
    registry = bootstrap.create_default_registry()
    tool_names = set(registry.list_tools())

    assert "search" in tool_names
    assert "memory" in tool_names
