from pathlib import Path

from src.skills.execution_guard import ExecutionAdvisor, ExecutionGuard


def test_validate_script_path_blocks_directory(tmp_path: Path) -> None:
    skill_root = tmp_path / "deep-research"
    scripts_dir = skill_root / "scripts"
    scripts_dir.mkdir(parents=True, exist_ok=True)

    guard = ExecutionGuard()
    result = guard.validate_script_path(skill_root, "scripts")

    assert result.blocked is True
    assert result.reason == "script_not_file"


def test_validate_script_path_blocks_outside_scripts(tmp_path: Path) -> None:
    skill_root = tmp_path / "deep-research"
    (skill_root / "reference").mkdir(parents=True, exist_ok=True)
    (skill_root / "reference" / "guide.md").write_text("guide", encoding="utf-8")

    guard = ExecutionGuard()
    result = guard.validate_script_path(skill_root, "reference/guide.md")

    assert result.blocked is True
    assert result.reason == "path_traversal"


def test_execution_advisor_errors_on_missing_required_flag(tmp_path: Path) -> None:
    skill_root = tmp_path / "deep-research"
    scripts_dir = skill_root / "scripts"
    scripts_dir.mkdir(parents=True, exist_ok=True)
    (scripts_dir / "research_engine.py").write_text(
        "\n".join(
            [
                "import argparse",
                "parser = argparse.ArgumentParser()",
                "parser.add_argument('--query', '-q', required=True)",
                "parser.add_argument('--max-results', type=int, default=5)",
                "parser.parse_args()",
            ]
        )
        + "\n",
        encoding="utf-8",
    )

    advisor = ExecutionAdvisor()
    advisory = advisor.check_script_help(skill_root, "scripts/research_engine.py", ["--max-results", "10"])

    assert advisory.level == "error"
    assert "missing required flags" in advisory.message
    assert "--query" in advisory.message


def test_execution_advisor_describes_script_interfaces(tmp_path: Path) -> None:
    skill_root = tmp_path / "deep-research"
    scripts_dir = skill_root / "scripts"
    scripts_dir.mkdir(parents=True, exist_ok=True)
    (scripts_dir / "research_engine.py").write_text(
        "\n".join(
            [
                "import argparse",
                "parser = argparse.ArgumentParser()",
                "parser.add_argument('--query', '-q', required=True)",
                "parser.add_argument('--mode', choices=['quick', 'deep'], default='quick')",
                "parser.parse_args()",
            ]
        )
        + "\n",
        encoding="utf-8",
    )

    advisor = ExecutionAdvisor()
    descriptions = advisor.describe_script_interfaces(skill_root, ["scripts/research_engine.py"])

    assert len(descriptions) == 1
    assert "scripts/research_engine.py:" in descriptions[0]
    assert "usage:" in descriptions[0].lower()
