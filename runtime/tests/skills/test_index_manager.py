from pathlib import Path

from src.skills.index_manager import SkillsIndexManager, _read_description


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


# ---------------------------------------------------------------------------
# _read_description YAML block scalar tests
# ---------------------------------------------------------------------------

def test_read_description_inline(tmp_path: Path) -> None:
    skill_dir = tmp_path / "inline"
    _write(skill_dir / "SKILL.md", "---\nname: test\ndescription: A simple tool\n---\n# Body\n")
    assert _read_description(skill_dir, "inline") == "A simple tool"


def test_read_description_block_scalar_pipe(tmp_path: Path) -> None:
    skill_dir = tmp_path / "block"
    _write(skill_dir / "SKILL.md", (
        "---\n"
        "name: test\n"
        "description: |\n"
        "  First line of description.\n"
        "  Second line of description.\n"
        "---\n"
        "# Body\n"
    ))
    desc = _read_description(skill_dir, "block")
    assert "First line" in desc
    assert "Second line" in desc


def test_read_description_block_scalar_folded(tmp_path: Path) -> None:
    skill_dir = tmp_path / "folded"
    _write(skill_dir / "SKILL.md", (
        "---\n"
        "name: test\n"
        "description: >\n"
        "  Folded first line.\n"
        "  Folded second line.\n"
        "---\n"
    ))
    desc = _read_description(skill_dir, "folded")
    assert "Folded first line." in desc
    assert "Folded second line." in desc


def test_read_description_falls_back_to_body(tmp_path: Path) -> None:
    skill_dir = tmp_path / "nobody"
    _write(skill_dir / "SKILL.md", "---\nname: test\n---\n# My Skill\nSome body text.\n")
    assert _read_description(skill_dir, "nobody") == "My Skill"
