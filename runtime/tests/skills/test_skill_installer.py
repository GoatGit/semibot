from __future__ import annotations

import zipfile
from pathlib import Path

import pytest
import json

from src.skills.registry import SkillRegistry
from src.skills.skill_installer import SkillInstallerTool


def _write_skill_package(base: Path) -> None:
    (base / "scripts").mkdir(parents=True, exist_ok=True)
    (base / "SKILL.md").write_text("# Demo Skill\n", encoding="utf-8")
    (base / "scripts" / "main.py").write_text("print('ok')\n", encoding="utf-8")


@pytest.mark.asyncio
async def test_skill_installer_installs_from_folder(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    home = tmp_path / "home"
    monkeypatch.setenv("SEMIBOT_HOME", str(home))
    src = tmp_path / "demo_skill"
    _write_skill_package(src)

    registry = SkillRegistry()
    tool = SkillInstallerTool(registry)
    result = await tool.execute(source_path=str(src), skill_name="demo_skill")
    assert result.success is True
    assert registry.get_tool("demo_skill") is not None


@pytest.mark.asyncio
async def test_skill_installer_installs_from_zip(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    home = tmp_path / "home2"
    monkeypatch.setenv("SEMIBOT_HOME", str(home))
    src = tmp_path / "zip_skill"
    _write_skill_package(src)
    zip_path = tmp_path / "zip_skill.zip"
    with zipfile.ZipFile(zip_path, "w") as zf:
        for file_path in src.rglob("*"):
            if file_path.is_file():
                zf.write(file_path, file_path.relative_to(src.parent))

    registry = SkillRegistry()
    tool = SkillInstallerTool(registry)
    result = await tool.execute(source_path=str(zip_path), skill_name="zip_skill")
    assert result.success is True
    assert registry.get_tool("zip_skill") is not None


@pytest.mark.asyncio
async def test_skill_installer_updates_index_file(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    home = tmp_path / "home3"
    monkeypatch.setenv("SEMIBOT_HOME", str(home))
    src = tmp_path / "indexed_skill"
    _write_skill_package(src)

    registry = SkillRegistry()
    tool = SkillInstallerTool(registry)
    result = await tool.execute(source_path=str(src), skill_name="indexed_skill")
    assert result.success is True

    index_path = home / "skills" / ".index.json"
    assert index_path.exists()
    payload = json.loads(index_path.read_text(encoding="utf-8"))
    skills = payload.get("skills", [])
    assert any(item.get("skill_id") == "indexed_skill" for item in skills)
