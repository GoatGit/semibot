from src.skills.skill_index_prompt import (
    build_skill_index_entries,
    format_skills_for_prompt,
    sort_skill_index_entries,
)


def test_build_skill_index_entries_filters_disabled_and_formats_prompt() -> None:
    entries = build_skill_index_entries(
        [
            {
                "skill_id": "deep-research",
                "name": "deep-research",
                "description": "Long description for research skill.",
                "when_to_use": "Use when the task needs structured research.",
                "script_files": ["scripts/research_engine.py", "scripts/validate_report.py"],
                "has_skill_md": True,
                "has_references": True,
                "has_templates": False,
                "execution_context": "fork",
                "effort": "high",
                "enabled": True,
            },
            {
                "skill_id": "disabled-skill",
                "enabled": False,
            },
        ]
    )

    payload = format_skills_for_prompt(entries, max_skills=5, max_chars=1200, max_desc_chars=60)

    assert len(entries) == 1
    assert 'id="deep-research"' in payload
    assert "<when_to_use>" in payload
    assert "structured research" in payload
    assert "<scripts>research_engine.py, validate_report.py</scripts>" in payload
    assert "<execution_context>fork</execution_context>" in payload
    assert "<effort>high</effort>" in payload
    assert "disabled-skill" not in payload


def test_sort_skill_index_entries_prefers_explicit_and_path_matches() -> None:
    entries = build_skill_index_entries(
        [
            {
                "skill_id": "docs-skill",
                "name": "docs-skill",
                "description": "Help with docs",
                "when_to_use": "Use for docs",
                "paths": ["docs/**"],
                "enabled": True,
            },
            {
                "skill_id": "generic",
                "name": "generic",
                "description": "Generic helper",
                "when_to_use": "",
                "enabled": True,
            },
        ]
    )

    ordered = sort_skill_index_entries(
        entries,
        user_text="please update docs/design/spec.md with docs-skill",
        active_paths=["docs/design/spec.md"],
    )

    assert ordered[0].skill_id == "docs-skill"
