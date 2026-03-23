from __future__ import annotations

from pathlib import Path

import pytest

from src.skills.cli_tool_provider import (
    CliManifestTool,
    CliToolManifest,
    _load_manifest,
    register_cli_manifest_tools,
)
from src.skills.registry import SkillMetadata, SkillRegistry


@pytest.mark.asyncio
async def test_cli_manifest_tool_returns_structured_error_for_missing_template_param(tmp_path: Path):
    skill_dir = tmp_path / "skill"
    skill_dir.mkdir(parents=True, exist_ok=True)
    tool = CliManifestTool(
        CliToolManifest(
            package_id="browser-tools",
            skill_dir=skill_dir,
            manifest_path=skill_dir / "cli-tools" / "browser_search.json",
            tool_id="cli:browser-tools:browser_search",
            provider_id="browser-tools",
            tool_name="browser_search",
            description="Browser search",
            command=["python3", "{skill_dir}/run.py", "{query}", "{missing_param}"],
            parameters={"type": "object", "properties": {"query": {"type": "string"}}},
            json_mode=True,
            output_schema={},
            stderr_policy="log_only",
            nonzero_exit_policy="error",
            timeout_seconds=30,
            metadata={},
        )
    )

    result = await tool.execute(query="ai news")

    assert result.success is False
    assert result.error is not None
    assert result.metadata["error_type"] == "invalid_command_template"


def test_register_cli_manifest_tools_only_unregisters_stale_packages(tmp_path: Path):
    skills_root = tmp_path / "skills"
    active_skill_dir = skills_root / "active-skill"
    active_skill_dir.mkdir(parents=True, exist_ok=True)
    (active_skill_dir / "cli-tools").mkdir(parents=True, exist_ok=True)
    (active_skill_dir / "cli-tools" / "browser_search.json").write_text(
        """
        {
          "tool_name": "browser_search",
          "description": "Browser search",
          "provider_id": "browser-tools",
          "command": ["python3", "{skill_dir}/run.py", "{query}"],
          "json_mode": true,
          "output_schema": {"type": "object"},
          "parameters": {"type": "object", "properties": {"query": {"type": "string"}}}
        }
        """.strip(),
        encoding="utf-8",
    )

    registry = SkillRegistry()
    registry.register_tool(
        type(
            "_StaleCliTool",
            (),
            {
                "name": "stale_cli_tool",
                "description": "stale",
                "parameters": {"type": "object", "properties": {}},
            },
        )(),
        SkillMetadata(source="cli", additional={"package_id": "stale-skill"}),
    )

    package_rows = {
        "active-skill": {
            "installed_path": str(active_skill_dir),
        }
    }

    result = register_cli_manifest_tools(registry, skills_root=skills_root, package_rows=package_rows)

    assert "stale_cli_tool" in result["removed"]
    assert "browser_search" in registry.list_tools()
    metadata = registry.get_tool_metadata("browser_search")
    assert metadata is not None
    assert metadata.additional["package_id"] == "active-skill"


def test_register_cli_manifest_tools_unregisters_removed_manifest_from_active_package(tmp_path: Path):
    skills_root = tmp_path / "skills"
    active_skill_dir = skills_root / "active-skill"
    active_skill_dir.mkdir(parents=True, exist_ok=True)
    (active_skill_dir / "cli-tools").mkdir(parents=True, exist_ok=True)

    registry = SkillRegistry()
    registry.register_tool(
        type(
            "_ExistingCliTool",
            (),
            {
                "name": "old_cli_tool",
                "description": "old",
                "parameters": {"type": "object", "properties": {}},
            },
        )(),
        SkillMetadata(source="cli", additional={"package_id": "active-skill"}),
    )

    result = register_cli_manifest_tools(
        registry,
        skills_root=skills_root,
        package_rows={"active-skill": {"installed_path": str(active_skill_dir)}},
    )

    assert "old_cli_tool" in result["removed"]
    assert "old_cli_tool" not in registry.list_tools()


def test_register_cli_manifest_tools_does_not_override_builtin_tool(tmp_path: Path):
    skills_root = tmp_path / "skills"
    active_skill_dir = skills_root / "active-skill"
    active_skill_dir.mkdir(parents=True, exist_ok=True)
    (active_skill_dir / "cli-tools").mkdir(parents=True, exist_ok=True)
    (active_skill_dir / "cli-tools" / "search.json").write_text(
        """
        {
          "tool_name": "search",
          "description": "cli search",
          "provider_id": "browser-tools",
          "command": ["python3", "{skill_dir}/run.py", "{query}"],
          "json_mode": true,
          "output_schema": {"type": "object"},
          "parameters": {"type": "object", "properties": {"query": {"type": "string"}}}
        }
        """.strip(),
        encoding="utf-8",
    )

    registry = SkillRegistry()
    builtin_tool = type(
        "_BuiltinSearchTool",
        (),
        {
            "name": "search",
            "description": "builtin search",
            "parameters": {"type": "object", "properties": {}},
        },
    )()
    registry.register_tool(builtin_tool, SkillMetadata(source="builtin"))

    result = register_cli_manifest_tools(
        registry,
        skills_root=skills_root,
        package_rows={"active-skill": {"installed_path": str(active_skill_dir)}},
    )

    assert registry.get_tool("search") is builtin_tool
    assert any(item["reason"] == "conflicts_with_non_cli_tool" for item in result["skipped"])


def test_load_manifest_rejects_shell_trampoline(tmp_path: Path):
    manifest_path = tmp_path / "cli-tools" / "danger.json"
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    manifest_path.write_text(
        """
        {
          "tool_name": "danger",
          "description": "danger",
          "command": ["bash", "-c", "echo {input}"]
        }
        """.strip(),
        encoding="utf-8",
    )

    manifest = _load_manifest(manifest_path, package_id="danger-skill")

    assert manifest is None
