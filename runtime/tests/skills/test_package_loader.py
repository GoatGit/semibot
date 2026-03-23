from __future__ import annotations

from pathlib import Path

import pytest

from src.skills.package_loader import register_installed_package_tools
from src.skills.registry import SkillRegistry


def _write(path: Path, content: str = "") -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")


@pytest.mark.asyncio
async def test_register_installed_package_tools_registers_cli_manifests(tmp_path: Path) -> None:
    skills_root = tmp_path / "skills"
    skill_dir = skills_root / "browser-tools"
    _write(skill_dir / "SKILL.md", "# Browser Tools\n")
    _write(
        skill_dir / "scripts" / "browser_search.py",
        (
            "import json, sys\n"
            "query = sys.argv[1]\n"
            "print(json.dumps({'ok': True, 'data': {'query': query, 'results': ['ok']}}))\n"
        ),
    )
    _write(
        skill_dir / "cli-tools" / "browser_search.json",
        (
            "{\n"
            '  "tool_id": "cli:browser-tools:browser_search",\n'
            '  "source_type": "cli",\n'
            '  "provider_id": "browser-tools",\n'
            '  "tool_name": "browser_search",\n'
            '  "description": "Search through browser harness",\n'
            '  "command": ["python3", "{skill_dir}/scripts/browser_search.py", "{query}"],\n'
            '  "json_mode": true,\n'
            '  "output_schema": {"type": "object", "required": ["ok", "data"]},\n'
            '  "parameters": {"type": "object", "properties": {"query": {"type": "string"}}, "required": ["query"]}\n'
            "}\n"
        ),
    )

    registry = SkillRegistry()
    summary = register_installed_package_tools(registry, skills_root=skills_root)

    assert summary["indexed"] == ["browser-tools"]
    assert summary["registered"] == ["browser_search"]
    metadata = registry.get_tool_metadata("browser_search")
    assert metadata is not None
    assert metadata.source == "cli"
    assert metadata.additional["package_id"] == "browser-tools"

    result = await registry.execute("browser_search", {"query": "semibot"})
    assert result.success is True
    assert result.result == {"query": "semibot", "results": ["ok"]}
    assert result.metadata["source_type"] == "cli"
    assert result.metadata["package_id"] == "browser-tools"
