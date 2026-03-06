from __future__ import annotations

from types import SimpleNamespace

from src.orchestrator.nodes import _merge_dynamic_registry_schemas


class _StubRegistry:
    def get_tool_schemas(self) -> list[dict]:
        return [
            {
                "type": "function",
                "function": {
                    "name": "installed_tool_x",
                    "description": "installed",
                    "parameters": {"type": "object", "properties": {}},
                },
            }
        ]


def test_merge_dynamic_registry_schemas_adds_missing_tool() -> None:
    base = [
        {"function": {"name": "search"}},
    ]
    ctx = SimpleNamespace(
        metadata={"skill_registry": _StubRegistry()},
        get_all_capability_names=lambda: ["search", "installed_tool_x"],
    )
    merged = _merge_dynamic_registry_schemas(base, ctx)
    names = [str((item.get("function") or {}).get("name") or "") for item in merged]
    assert "search" in names
    assert "installed_tool_x" in names


def test_merge_dynamic_registry_schemas_filters_out_unbound_tool() -> None:
    base = [{"function": {"name": "search"}}]
    ctx = SimpleNamespace(
        metadata={"skill_registry": _StubRegistry()},
        get_all_capability_names=lambda: ["search"],
    )
    merged = _merge_dynamic_registry_schemas(base, ctx)
    names = [str((item.get("function") or {}).get("name") or "") for item in merged]
    assert "search" in names
    assert "installed_tool_x" not in names
