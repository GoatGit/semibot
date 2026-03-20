from __future__ import annotations

import zipfile
from pathlib import Path
from unittest.mock import patch

import pytest
import json

from src.skills.registry import SkillRegistry
from src.skills.skill_installer import SkillInstallerTool, _search_registry, _is_auth_failure


def _write_skill_package(base: Path) -> None:
    (base / "scripts").mkdir(parents=True, exist_ok=True)
    (base / "SKILL.md").write_text("# Demo Skill\n", encoding="utf-8")
    (base / "scripts" / "main.py").write_text("print('ok')\n", encoding="utf-8")


def _write_instruction_skill(base: Path) -> None:
    base.mkdir(parents=True, exist_ok=True)
    (base / "SKILL.md").write_text("# Instruction Skill\n", encoding="utf-8")


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
    assert registry.get_tool("demo_skill") is None


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
    assert registry.get_tool("zip_skill") is None


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


@pytest.mark.asyncio
async def test_skill_installer_supports_instruction_only_skill(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    home = tmp_path / "home4"
    monkeypatch.setenv("SEMIBOT_HOME", str(home))
    src = tmp_path / "instruction_skill"
    _write_instruction_skill(src)

    registry = SkillRegistry()
    tool = SkillInstallerTool(registry)
    result = await tool.execute(source_path=str(src), skill_name="instruction_skill")
    assert result.success is True
    assert registry.get_tool("instruction_skill") is None

    index_path = home / "skills" / ".index.json"
    payload = json.loads(index_path.read_text(encoding="utf-8"))
    skills = payload.get("skills", [])
    row = next(item for item in skills if item.get("skill_id") == "instruction_skill")
    assert row.get("has_skill_md") is True
    assert row.get("script_files") == []


# ---------------------------------------------------------------------------
# _search_registry unit tests
# ---------------------------------------------------------------------------

class TestSearchRegistry:
    """Tests for short-name auto-resolve via _search_registry."""

    def test_extracts_full_name_from_search_output(self) -> None:
        fake_stdout = (
            "Found 1 skill:\n"
            "  zhjiang22/openclaw-xhs@xiaohongshu - Xiaohongshu poster\n"
        )
        with patch(
            "src.skills.skill_installer._run_skills_cli",
            return_value=(0, fake_stdout, ""),
        ):
            result = _search_registry("xiaohongshu")
        assert result == "zhjiang22/openclaw-xhs@xiaohongshu"

    def test_returns_none_on_no_match(self) -> None:
        with patch(
            "src.skills.skill_installer._run_skills_cli",
            return_value=(0, "No skills found.\n", ""),
        ):
            result = _search_registry("nonexistent")
        assert result is None

    def test_returns_none_on_cli_failure(self) -> None:
        with patch(
            "src.skills.skill_installer._run_skills_cli",
            return_value=(1, "", "error"),
        ):
            result = _search_registry("broken")
        assert result is None

    def test_picks_first_match_from_multiple_results(self) -> None:
        fake_stdout = (
            "Found 2 skills:\n"
            "  alice/repo-a@skill-one - First\n"
            "  bob/repo-b@skill-two - Second\n"
        )
        with patch(
            "src.skills.skill_installer._run_skills_cli",
            return_value=(0, fake_stdout, ""),
        ):
            result = _search_registry("skill")
        assert result == "alice/repo-a@skill-one"


@pytest.mark.asyncio
async def test_registry_install_short_name_resolves(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Short name like 'xiaohongshu' should be resolved via search before install."""
    home = tmp_path / "home5"
    monkeypatch.setenv("SEMIBOT_HOME", str(home))
    skills_root = home / "skills"
    skills_root.mkdir(parents=True, exist_ok=True)

    registry = SkillRegistry()
    tool = SkillInstallerTool(registry)

    with patch(
        "src.skills.skill_installer._search_registry",
        return_value="zhjiang22/openclaw-xhs@xiaohongshu",
    ) as mock_search, patch(
        "src.skills.skill_installer._run_skills_cli",
        return_value=(0, "Installed successfully", ""),
    ):
        result = await tool.execute(registry_name="xiaohongshu")

    mock_search.assert_called_once_with("xiaohongshu")
    assert result.success is True


@pytest.mark.asyncio
async def test_registry_install_short_name_not_found(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Short name with no search results should return error."""
    home = tmp_path / "home6"
    monkeypatch.setenv("SEMIBOT_HOME", str(home))

    registry = SkillRegistry()
    tool = SkillInstallerTool(registry)

    with patch(
        "src.skills.skill_installer._search_registry",
        return_value=None,
    ):
        result = await tool.execute(registry_name="nonexistent")

    assert result.success is False
    assert "No skill matching" in (result.error or "")


# ---------------------------------------------------------------------------
# Auth failure detection tests
# ---------------------------------------------------------------------------

class TestAuthFailureDetection:
    """Tests for _is_auth_failure pattern matching."""

    def test_detects_authentication_failed(self) -> None:
        assert _is_auth_failure("", "Authentication failed for https://github.com/owner/repo.git")

    def test_detects_could_not_read_username(self) -> None:
        assert _is_auth_failure("", "fatal: could not read Username for 'https://github.com'")

    def test_detects_terminal_prompts_disabled(self) -> None:
        assert _is_auth_failure("terminal prompts disabled", "")

    def test_detects_permission_denied(self) -> None:
        assert _is_auth_failure("", "Permission denied (publickey)")

    def test_no_false_positive_on_normal_error(self) -> None:
        assert not _is_auth_failure("", "npm ERR! 404 Not Found")


@pytest.mark.asyncio
async def test_registry_install_auth_failure_triggers_gh_login(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Auth failure during install should attempt gh auth login --web."""
    home = tmp_path / "home7"
    monkeypatch.setenv("SEMIBOT_HOME", str(home))

    registry = SkillRegistry()
    tool = SkillInstallerTool(registry)

    call_count = 0

    def fake_run_skills_cli(args: list[str], timeout: int = 120) -> tuple[int, str, str]:
        nonlocal call_count
        call_count += 1
        if call_count == 1:
            # First call: auth failure
            return (128, "", "Authentication failed for https://github.com/owner/repo.git")
        # After auth: success
        return (0, "Installed successfully", "")

    with patch(
        "src.skills.skill_installer._run_skills_cli",
        side_effect=fake_run_skills_cli,
    ), patch(
        "src.skills.skill_installer._try_gh_auth_web",
        return_value={"success": True, "message": "GitHub 认证成功！"},
    ) as mock_auth:
        result = await tool.execute(registry_name="owner/repo@skill")

    mock_auth.assert_called_once()
    assert result.success is True


@pytest.mark.asyncio
async def test_registry_install_auth_failure_returns_code_and_url(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """When gh auth login --web returns a device code, error should contain it."""
    home = tmp_path / "home8"
    monkeypatch.setenv("SEMIBOT_HOME", str(home))

    registry = SkillRegistry()
    tool = SkillInstallerTool(registry)

    with patch(
        "src.skills.skill_installer._run_skills_cli",
        return_value=(128, "", "Authentication failed for https://github.com/owner/repo.git"),
    ), patch(
        "src.skills.skill_installer._try_gh_auth_web",
        return_value={
            "success": False,
            "auth_required": True,
            "code": "ABCD-1234",
            "url": "https://github.com/login/device",
            "message": "请在浏览器中打开 https://github.com/login/device 并输入验证码: ABCD-1234",
        },
    ):
        result = await tool.execute(registry_name="owner/repo@skill")

    assert result.success is False
    assert "ABCD-1234" in (result.error or "")
    assert "github.com/login/device" in (result.error or "")
