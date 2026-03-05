from pathlib import Path

from src.skills.index_manager import SkillsIndexManager


def _write(path: Path, content: str = "") -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")


def test_reindex_detects_instruction_package_hybrid(tmp_path: Path) -> None:
    skills_root = tmp_path / "skills"
    skills_root.mkdir(parents=True, exist_ok=True)

    _write(skills_root / "instruction-only" / "SKILL.md", "# instruction")
    _write(skills_root / "package-only" / "scripts" / "main.py", "print('ok')")
    _write(skills_root / "hybrid-skill" / "SKILL.md", "# hybrid")
    _write(skills_root / "hybrid-skill" / "scripts" / "main.py", "print('ok')")

    index = SkillsIndexManager(skills_root)
    result = index.reindex(scope="full")
    assert result["total"] == 3

    rows = {row["skill_id"]: row for row in index.list_records()}
    assert rows["instruction-only"]["kind"] == "instruction"
    assert rows["package-only"]["kind"] == "package"
    assert rows["hybrid-skill"]["kind"] == "hybrid"


def test_upsert_after_install_supports_instruction_skill(tmp_path: Path) -> None:
    skills_root = tmp_path / "skills"
    skills_root.mkdir(parents=True, exist_ok=True)
    _write(skills_root / "doc-skill" / "SKILL.md", "# doc skill")

    index = SkillsIndexManager(skills_root)
    row = index.upsert_after_install("doc-skill", source="manual")
    assert row["kind"] == "instruction"
    assert row["skill_md_path"] == "SKILL.md"
