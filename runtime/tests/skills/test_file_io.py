"""Tests for file_io builtin tool."""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from src.skills.file_io import FileIOTool
from src.skills.skill_injection_tracker import SkillInjectionTracker


@pytest.mark.asyncio
async def test_file_io_read_skill_scope_reads_skill_md(tmp_path, monkeypatch) -> None:
    skills_root = tmp_path / "skills"
    skill_dir = skills_root / "deep-research"
    skill_dir.mkdir(parents=True)
    (skill_dir / "SKILL.md").write_text("# Deep Research\n", encoding="utf-8")
    monkeypatch.setenv("SEMIBOT_SKILLS_PATH", str(skills_root))

    tool = FileIOTool()
    result = await tool.execute(action="read", scope="skill", skill_name="deep-research", path="SKILL.md")

    assert result.success is True
    payload = result.result or {}
    assert payload.get("skill_name") == "deep-research"
    assert payload.get("path") == "SKILL.md"
    assert "Deep Research" in str(payload.get("content") or "")
    assert payload.get("cached") is False
    assert payload.get("scope") == "skill"


@pytest.mark.asyncio
async def test_file_io_read_skill_scope_blocks_path_escape(tmp_path, monkeypatch) -> None:
    skills_root = tmp_path / "skills"
    skill_dir = skills_root / "deep-research"
    skill_dir.mkdir(parents=True)
    (skill_dir / "SKILL.md").write_text("# Deep Research\n", encoding="utf-8")
    monkeypatch.setenv("SEMIBOT_SKILLS_PATH", str(skills_root))

    tool = FileIOTool()
    result = await tool.execute(action="read", scope="skill", skill_name="deep-research", path="../secret.txt")

    assert result.success is False
    assert "escapes skill directory" in str(result.error or "")


@pytest.mark.asyncio
async def test_file_io_read_skill_scope_blocks_non_resource_directory(tmp_path, monkeypatch) -> None:
    skills_root = tmp_path / "skills"
    skill_dir = skills_root / "deep-research"
    (skill_dir / "tests").mkdir(parents=True)
    (skill_dir / "tests" / "spec.md").write_text("secret", encoding="utf-8")
    monkeypatch.setenv("SEMIBOT_SKILLS_PATH", str(skills_root))

    tool = FileIOTool()
    result = await tool.execute(action="read", scope="skill", skill_name="deep-research", path="tests/spec.md")

    assert result.success is False
    assert "restricted" in str(result.error or "")


@pytest.mark.asyncio
async def test_file_io_read_skill_scope_uses_tracker_cache(tmp_path, monkeypatch) -> None:
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
        action="read",
        scope="skill",
        skill_name="deep-research",
        path="reference/guide.md",
        _runtime_context=runtime_context,
    )
    second = await tool.execute(
        action="read",
        scope="skill",
        skill_name="deep-research",
        path="reference/guide.md",
        _runtime_context=runtime_context,
    )

    assert first.success is True
    assert second.success is True
    assert (first.result or {}).get("cached") is False
    assert (second.result or {}).get("cached") is True


@pytest.mark.asyncio
async def test_file_io_uses_session_working_dir_for_read_write_list(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("SEMIBOT_FILE_IO_ROOT", str(tmp_path / "global-root"))
    session_root = tmp_path / "session-workdir"
    runtime_context = SimpleNamespace(metadata={"session_working_dir": str(session_root)})
    tool = FileIOTool()

    write_result = await tool.execute(
        action="write",
        path="notes/report.md",
        content="# report\n",
        _runtime_context=runtime_context,
    )
    list_result = await tool.execute(
        action="list",
        path=".",
        recursive=True,
        _runtime_context=runtime_context,
    )
    read_result = await tool.execute(
        action="read",
        path="notes/report.md",
        _runtime_context=runtime_context,
    )

    assert write_result.success is True
    assert read_result.success is True
    assert list_result.success is True
    assert (write_result.result or {}).get("ok") is True
    assert (write_result.result or {}).get("updated") is True
    assert (write_result.result or {}).get("path") == "notes/report.md"
    assert isinstance((write_result.result or {}).get("bytes"), int)
    assert "root" not in (write_result.result or {})
    assert "content_preview" not in (write_result.result or {})
    generated = (write_result.metadata or {}).get("generated_files") or []
    assert len(generated) == 1
    assert generated[0].get("filename") == "report.md"
    assert generated[0].get("artifact_result_path") == "notes/report.md"
    assert (read_result.result or {}).get("root") == str(session_root.resolve())
    assert (read_result.result or {}).get("path") == "notes/report.md"
    assert "# report" in str((read_result.result or {}).get("content") or "")
    items = (list_result.result or {}).get("items") or []
    assert any(item.get("path") == "notes/report.md" for item in items)


@pytest.mark.asyncio
async def test_file_io_edit_returns_minimal_confirmation_payload(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("SEMIBOT_FILE_IO_ROOT", str(tmp_path))
    tool = FileIOTool()
    target = tmp_path / "notes.txt"
    target.write_text("hello world", encoding="utf-8")

    edit_result = await tool.execute(
        action="edit",
        path="notes.txt",
        old_text="world",
        new_text="semibot",
    )

    assert edit_result.success is True
    payload = edit_result.result or {}
    assert payload.get("ok") is True
    assert payload.get("updated") is True
    assert payload.get("path") == "notes.txt"
    assert isinstance(payload.get("bytes"), int)
    assert "content_preview" not in payload
    assert "root" not in payload
    generated = (edit_result.metadata or {}).get("generated_files") or []
    assert len(generated) == 1
    assert generated[0].get("filename") == "notes.txt"
    assert target.read_text(encoding="utf-8") == "hello semibot"


@pytest.mark.asyncio
async def test_file_io_exec_is_no_longer_supported(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("SEMIBOT_FILE_IO_ROOT", str(tmp_path))
    tool = FileIOTool()

    result = await tool.execute(action="exec", path=".", command="pwd")

    assert result.success is False
    assert "Unsupported action: exec" in str(result.error or "")


@pytest.mark.asyncio
async def test_file_io_skill_scope_list_is_read_only_and_whitelisted(tmp_path, monkeypatch) -> None:
    skills_root = tmp_path / "skills"
    skill_dir = skills_root / "deep-research"
    (skill_dir / "reference").mkdir(parents=True)
    (skill_dir / "reference" / "guide.md").write_text("guide", encoding="utf-8")
    (skill_dir / "scripts").mkdir(parents=True)
    (skill_dir / "scripts" / "secret.py").write_text("print('x')", encoding="utf-8")
    monkeypatch.setenv("SEMIBOT_SKILLS_PATH", str(skills_root))

    tool = FileIOTool()
    list_result = await tool.execute(action="list", scope="skill", skill_name="deep-research", path="reference")
    write_result = await tool.execute(action="write", scope="skill", skill_name="deep-research", path="SKILL.md", content="x")

    assert list_result.success is True
    items = (list_result.result or {}).get("items") or []
    assert any(item.get("path") == "reference/guide.md" for item in items)
    assert all(item.get("path") != "scripts/secret.py" for item in items)
    assert write_result.success is False
    assert "read-only" in str(write_result.error or "")
