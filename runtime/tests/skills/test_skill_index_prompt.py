from src.skills.skill_index_prompt import build_skill_index_entries, format_skills_for_prompt


def test_build_skill_index_entries_filters_disabled_and_formats_prompt() -> None:
    entries = build_skill_index_entries(
        [
            {
                "skill_id": "deep-research",
                "name": "deep-research",
                "description": "Long description for research skill.",
                "script_files": ["scripts/research_engine.py", "scripts/validate_report.py"],
                "has_skill_md": True,
                "has_references": True,
                "has_templates": False,
                "enabled": True,
            },
            {
                "skill_id": "disabled-skill",
                "enabled": False,
            },
        ]
    )

    payload = format_skills_for_prompt(entries, max_skills=5, max_chars=600, max_desc_chars=30)

    assert len(entries) == 1
    assert 'id="deep-research"' in payload
    assert "<scripts>research_engine.py, validate_report.py</scripts>" in payload
    assert "disabled-skill" not in payload
