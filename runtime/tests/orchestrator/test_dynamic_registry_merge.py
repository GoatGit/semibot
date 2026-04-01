from __future__ import annotations

from types import SimpleNamespace

from src.orchestrator.nodes_plan import _merge_dynamic_registry_schemas


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


def test_merge_dynamic_registry_schemas_skips_group_cli_parent_when_leaf_projection_exists() -> None:
    class _GroupCliRegistry:
        def get_tool_schemas(self) -> list[dict]:
            return [
                {
                    "type": "function",
                    "function": {
                        "name": "opencli_xiaohongshu",
                        "description": "Usage: opencli xiaohongshu [options] [command]",
                        "parameters": {
                            "type": "object",
                            "properties": {
                                "command": {"type": "string"},
                                "query": {"type": "string"},
                            },
                        },
                    },
                }
            ]

    base = [
        {
            "type": "function",
            "function": {
                "name": "opencli_xiaohongshu_search",
                "description": "Search Xiaohongshu notes",
                "parameters": {
                    "type": "object",
                    "properties": {"query": {"type": "string"}},
                    "required": ["query"],
                },
            },
        }
    ]

    ctx = SimpleNamespace(
        metadata={"skill_registry": _GroupCliRegistry()},
        get_all_capability_names=lambda: ["opencli_xiaohongshu", "opencli_xiaohongshu_search"],
        get_tool_catalog_entry=lambda name: SimpleNamespace(source_type="cli", metadata={"shape": "group"})
        if name == "opencli_xiaohongshu"
        else None,
    )

    merged = _merge_dynamic_registry_schemas(base, ctx)
    names = [str((item.get("function") or {}).get("name") or "") for item in merged]

    assert "opencli_xiaohongshu_search" in names
    assert "opencli_xiaohongshu" not in names
