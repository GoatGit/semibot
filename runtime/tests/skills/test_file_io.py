"""Tests for file_io builtin tool."""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from src.skills.file_io import FileIOTool
from src.skills.skill_injection_tracker import SkillInjectionTracker


@pytest.mark.asyncio
async def test_file_io_read_skill_file_reads_skill_md(tmp_path, monkeypatch) -> None:
    skills_root = tmp_path / "skills"
    skill_dir = skills_root / "deep-research"
    skill_dir.mkdir(parents=True)
    (skill_dir / "SKILL.md").write_text("# Deep Research\n", encoding="utf-8")
    monkeypatch.setenv("SEMIBOT_SKILLS_PATH", str(skills_root))

    tool = FileIOTool()
    result = await tool.execute(action="read_skill_file", skill_name="deep-research", file_path="SKILL.md")

    assert result.success is True
    payload = result.result or {}
    assert payload.get("skill_name") == "deep-research"
    assert payload.get("file_path") == "SKILL.md"
    assert "Deep Research" in str(payload.get("content") or "")
    assert payload.get("cached") is False


@pytest.mark.asyncio
async def test_file_io_read_skill_file_blocks_path_escape(tmp_path, monkeypatch) -> None:
    skills_root = tmp_path / "skills"
    skill_dir = skills_root / "deep-research"
    skill_dir.mkdir(parents=True)
    (skill_dir / "SKILL.md").write_text("# Deep Research\n", encoding="utf-8")
    monkeypatch.setenv("SEMIBOT_SKILLS_PATH", str(skills_root))

    tool = FileIOTool()
    result = await tool.execute(action="read_skill_file", skill_name="deep-research", file_path="../secret.txt")

    assert result.success is False
    assert "escapes skill directory" in str(result.error or "")


@pytest.mark.asyncio
async def test_file_io_read_skill_file_blocks_non_resource_directory(tmp_path, monkeypatch) -> None:
    skills_root = tmp_path / "skills"
    skill_dir = skills_root / "deep-research"
    (skill_dir / "tests").mkdir(parents=True)
    (skill_dir / "tests" / "spec.md").write_text("secret", encoding="utf-8")
    monkeypatch.setenv("SEMIBOT_SKILLS_PATH", str(skills_root))

    tool = FileIOTool()
    result = await tool.execute(action="read_skill_file", skill_name="deep-research", file_path="tests/spec.md")

    assert result.success is False
    assert "restricted" in str(result.error or "")


@pytest.mark.asyncio
async def test_file_io_read_skill_file_uses_tracker_cache(tmp_path, monkeypatch) -> None:
    skills_root = tmp_path / "skills"
    skill_dir = skills_root / "deep-research"
    (skill_dir / "reference").mkdir(parents=True)
    target = skill_dir / "reference" / "guide.md"
    target.write_text("v1", encoding="utf-8")
    monkeypatch.setenv("SEMIBOT_SKILLS_PATH", str(skills_root))

    tracker = SkillInjectionTracker()
    runtime_context = SimpleNamespace(skill_injection_tracker=tracker)
    tool = FileIOTool()

    first = await tool.execute(
        action="read_skill_file",
        skill_name="deep-research",
        file_path="reference/guide.md",
        _runtime_context=runtime_context,
    )
    second = await tool.execute(
        action="read_skill_file",
        skill_name="deep-research",
        file_path="reference/guide.md",
        _runtime_context=runtime_context,
    )

    assert first.success is True
    assert second.success is True
    assert (first.result or {}).get("cached") is False
    assert (second.result or {}).get("cached") is True
