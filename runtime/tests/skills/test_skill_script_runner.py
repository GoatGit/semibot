"""Tests for skill_script_runner tool."""

from __future__ import annotations

import os
from pathlib import Path

import pytest

from src.skills.skill_script_runner import SkillScriptRunnerTool


@pytest.mark.asyncio
async def test_skill_script_runner_executes_python_script(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    skills_root = tmp_path / "skills"
    script_dir = skills_root / "demo-skill" / "scripts"
    script_dir.mkdir(parents=True, exist_ok=True)
    (script_dir / "echo.py").write_text("print('ok-runner')\n", encoding="utf-8")
    monkeypatch.setenv("SEMIBOT_SKILLS_PATH", str(skills_root))

    tool = SkillScriptRunnerTool()
    result = await tool.execute(
        skill_name="demo-skill",
        command="python scripts/echo.py",
    )

    assert result.success is True
    assert isinstance(result.result, dict)
    assert "ok-runner" in str(result.result.get("stdout") or "")


@pytest.mark.asyncio
async def test_skill_script_runner_executes_bash_script(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    skills_root = tmp_path / "skills"
    script_dir = skills_root / "demo-skill" / "scripts"
    script_dir.mkdir(parents=True, exist_ok=True)
    script_file = script_dir / "echo.sh"
    script_file.write_text("echo ok-bash\n", encoding="utf-8")
    monkeypatch.setenv("SEMIBOT_SKILLS_PATH", str(skills_root))

    tool = SkillScriptRunnerTool()
    result = await tool.execute(
        skill_name="demo-skill",
        command="bash scripts/echo.sh",
    )

    assert result.success is True
    assert "ok-bash" in str((result.result or {}).get("stdout") or "")


@pytest.mark.asyncio
async def test_skill_script_runner_blocks_command_without_scripts_reference(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    skills_root = tmp_path / "skills"
    script_dir = skills_root / "demo-skill" / "scripts"
    script_dir.mkdir(parents=True, exist_ok=True)
    monkeypatch.setenv("SEMIBOT_SKILLS_PATH", str(skills_root))

    tool = SkillScriptRunnerTool()
    result = await tool.execute(
        skill_name="demo-skill",
        command="echo hello",
    )

    assert result.success is False
    assert "scripts/" in str(result.error or "")


@pytest.mark.asyncio
async def test_skill_script_runner_resolves_bare_script_filename(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    skills_root = tmp_path / "skills"
    script_dir = skills_root / "demo-skill" / "scripts"
    script_dir.mkdir(parents=True, exist_ok=True)
    (script_dir / "research_engine.py").write_text("print('ok-bare')\n", encoding="utf-8")
    monkeypatch.setenv("SEMIBOT_SKILLS_PATH", str(skills_root))

    tool = SkillScriptRunnerTool()
    result = await tool.execute(
        skill_name="demo-skill",
        command="python research_engine.py --query test",
    )

    assert result.success is True
    assert "ok-bare" in str((result.result or {}).get("stdout") or "")
    assert "scripts/research_engine.py" in str((result.result or {}).get("resolved_command") or "")


@pytest.mark.asyncio
async def test_skill_script_runner_rewrites_close_match_script_name(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    skills_root = tmp_path / "skills"
    script_dir = skills_root / "demo-skill" / "scripts"
    script_dir.mkdir(parents=True, exist_ok=True)
    (script_dir / "validate_report.py").write_text("print('ok-validate')\n", encoding="utf-8")
    monkeypatch.setenv("SEMIBOT_SKILLS_PATH", str(skills_root))

    tool = SkillScriptRunnerTool()
    result = await tool.execute(
        skill_name="demo-skill",
        command="python scripts/validate_reports.py --report out.md",
    )

    assert result.success is True
    assert "ok-validate" in str((result.result or {}).get("stdout") or "")
    rewrites = (result.result or {}).get("command_rewrites") or []
    assert any("validate_reports.py" in str(item) and "validate_report.py" in str(item) for item in rewrites)


@pytest.mark.asyncio
async def test_skill_script_runner_blocks_known_bad_cli_args(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    skills_root = tmp_path / "skills"
    script_dir = skills_root / "deep-research" / "scripts"
    script_dir.mkdir(parents=True, exist_ok=True)
    (script_dir / "research_engine.py").write_text(
        "\n".join(
            [
                "import argparse",
                "parser = argparse.ArgumentParser()",
                "parser.add_argument('--query', '-q', required=True)",
                "parser.add_argument('--max-results', type=int, default=5)",
                "parser.parse_args()",
                "print('ok')",
            ]
        )
        + "\n",
        encoding="utf-8",
    )
    monkeypatch.setenv("SEMIBOT_SKILLS_PATH", str(skills_root))

    tool = SkillScriptRunnerTool()
    result = await tool.execute(
        skill_name="deep-research",
        command="python scripts/research_engine.py --topic pdd --min_sources 3",
    )

    assert result.success is False
    assert "missing required flags" in str(result.error or "")
    assert isinstance(result.metadata, dict)
    advisory = result.metadata.get("advisory") or {}
    assert advisory.get("level") == "error"
    assert "--topic" in str(advisory.get("message") or "")
    assert "--min_sources" in str(advisory.get("message") or "")


@pytest.mark.asyncio
async def test_skill_script_runner_fails_when_claimed_artifact_missing(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    skills_root = tmp_path / "skills"
    script_dir = skills_root / "demo-skill" / "scripts"
    script_dir.mkdir(parents=True, exist_ok=True)
    missing_path = tmp_path / "out" / "report.md"
    (script_dir / "claim.py").write_text(
        "\n".join(
            [
                "import argparse",
                "parser = argparse.ArgumentParser()",
                "parser.parse_args()",
                f"print('Saved to: {missing_path}')",
            ]
        ) + "\n",
        encoding="utf-8",
    )
    monkeypatch.setenv("SEMIBOT_SKILLS_PATH", str(skills_root))

    tool = SkillScriptRunnerTool()
    result = await tool.execute(
        skill_name="demo-skill",
        command="python scripts/claim.py",
    )

    assert result.success is False
    assert "do not exist" in str(result.error or "")
    advisory = result.metadata.get("advisory") or {}
    assert advisory.get("level") == "error"
    payload = result.metadata.get("payload") or {}
    assert str(missing_path) in (payload.get("missing_claimed_artifacts") or [])


@pytest.mark.asyncio
async def test_skill_script_runner_keeps_success_when_claimed_artifact_exists(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    skills_root = tmp_path / "skills"
    script_dir = skills_root / "demo-skill" / "scripts"
    script_dir.mkdir(parents=True, exist_ok=True)
    artifact_path = tmp_path / "out" / "report.md"
    artifact_path.parent.mkdir(parents=True, exist_ok=True)
    (script_dir / "claim.py").write_text(
        "\n".join(
            [
                "import argparse",
                "from pathlib import Path",
                "parser = argparse.ArgumentParser()",
                "parser.parse_args()",
                f"path = Path(r'{artifact_path}')",
                "path.write_text('# report\\n', encoding='utf-8')",
                "print(f'Written to: {path}')",
            ]
        ) + "\n",
        encoding="utf-8",
    )
    monkeypatch.setenv("SEMIBOT_SKILLS_PATH", str(skills_root))

    tool = SkillScriptRunnerTool()
    result = await tool.execute(
        skill_name="demo-skill",
        command="python scripts/claim.py",
    )

    assert result.success is True
    payload = result.result or {}
    assert str(artifact_path) in (payload.get("claimed_artifacts") or [])


@pytest.mark.asyncio
async def test_skill_script_runner_ignores_future_tense_artifact_text(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    skills_root = tmp_path / "skills"
    script_dir = skills_root / "demo-skill" / "scripts"
    script_dir.mkdir(parents=True, exist_ok=True)
    missing_path = tmp_path / "out" / "report.md"
    (script_dir / "claim.py").write_text(
        "\n".join(
            [
                "import argparse",
                "parser = argparse.ArgumentParser()",
                "parser.parse_args()",
                f"print('Report will be saved to: {missing_path}')",
                f"print('Research complete! Report path: {missing_path}')",
            ]
        ) + "\n",
        encoding="utf-8",
    )
    monkeypatch.setenv("SEMIBOT_SKILLS_PATH", str(skills_root))

    tool = SkillScriptRunnerTool()
    result = await tool.execute(
        skill_name="demo-skill",
        command="python scripts/claim.py",
    )

    assert result.success is True
    payload = result.result or {}
    assert payload.get("claimed_artifacts") in (None, [])
