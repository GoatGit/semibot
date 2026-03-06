from pathlib import Path

from src.skills.index_manager import SkillsIndexManager


def _write(path: Path, content: str = "") -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")


def test_reindex_detects_skills_with_docs_or_scripts(tmp_path: Path) -> None:
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
    assert rows["instruction-only"]["script_files"] == []
    assert rows["package-only"]["script_files"] == ["scripts/main.py"]
    assert rows["instruction-only"]["has_skill_md"] is True
    assert rows["hybrid-skill"]["has_skill_md"] is True


def test_upsert_after_install_supports_doc_only_skill(tmp_path: Path) -> None:
    skills_root = tmp_path / "skills"
    skills_root.mkdir(parents=True, exist_ok=True)
    _write(skills_root / "doc-skill" / "SKILL.md", "# doc skill")

    index = SkillsIndexManager(skills_root)
    row = index.upsert_after_install("doc-skill", source="manual")
    assert row["has_skill_md"] is True
    assert row["script_files"] == []


def test_reindex_keeps_script_inventory_without_main_py(tmp_path: Path) -> None:
    skills_root = tmp_path / "skills"
    skills_root.mkdir(parents=True, exist_ok=True)
    _write(skills_root / "hybrid-no-main" / "SKILL.md", "# hybrid")
    _write(skills_root / "hybrid-no-main" / "scripts" / "research_engine.py", "print('ok')")

    index = SkillsIndexManager(skills_root)
    index.reindex(scope="full")
    rows = {row["skill_id"]: row for row in index.list_records()}

    assert rows["hybrid-no-main"]["has_skill_md"] is True
    assert rows["hybrid-no-main"]["script_files"] == ["scripts/research_engine.py"]


def test_reindex_persists_resource_presence_flags(tmp_path: Path) -> None:
    skills_root = tmp_path / "skills"
    skills_root.mkdir(parents=True, exist_ok=True)
    _write(skills_root / "resource-skill" / "SKILL.md", "# resource skill")
    _write(skills_root / "resource-skill" / "reference" / "guide.md", "guide")
    _write(skills_root / "resource-skill" / "templates" / "report.md", "template")
    _write(skills_root / "resource-skill" / "scripts" / "run.py", "print('ok')")

    index = SkillsIndexManager(skills_root)
    index.reindex(scope="full")

    rows = {row["skill_id"]: row for row in index.list_records()}
    record = rows["resource-skill"]
    assert record["has_skill_md"] is True
    assert record["has_references"] is True
    assert record["has_templates"] is True
    assert record["script_files"] == ["scripts/run.py"]
