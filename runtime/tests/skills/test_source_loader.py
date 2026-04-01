from src.skills.source_loader import (
    apply_skill_visibility,
    compact_skill_summary,
    dedupe_skill_index,
)


def test_dedupe_skill_index_prefers_higher_priority_source() -> None:
    rows = dedupe_skill_index(
        [
            {"skill_id": "deep-research", "source": "bundled", "description": "bundled"},
            {"skill_id": "deep-research", "source": "project", "description": "project"},
        ]
    )
    assert len(rows) == 1
    assert rows[0]["source"] == "project"


def test_compact_skill_summary_keeps_runtime_relevant_fields() -> None:
    summary = compact_skill_summary(
        {
            "skill_id": "deep-research",
            "name": "deep-research",
            "description": "Research",
            "when_to_use": "Use for research",
            "execution_context": "fork",
            "effort": "high",
            "paths": ["docs/**"],
            "allowed_tools": ["search"],
            "resources": {
                "has_skill_md": True,
                "has_references": True,
                "has_templates": False,
                "script_files": ["scripts/research.py"],
            },
        }
    )

    assert summary["skill_id"] == "deep-research"
    assert summary["when_to_use"] == "Use for research"
    assert summary["execution_context"] == "fork"
    assert summary["effort"] == "high"
    assert summary["resources"]["script_files"] == ["scripts/research.py"]


def test_apply_skill_visibility_respects_explicit_skill_ids() -> None:
    visible = apply_skill_visibility(
        [
            {"skill_id": "deep-research", "disable_model_invocation": True},
            {"skill_id": "writer", "disable_model_invocation": True},
        ],
        explicitly_invoked_skill_ids=["deep-research"],
    )

    by_id = {item["skill_id"]: item for item in visible}
    assert by_id["deep-research"]["visible_to_model"] is True
    assert by_id["deep-research"]["user_invoked"] is True
    assert by_id["writer"]["visible_to_model"] is False
    assert by_id["writer"]["user_invoked"] is False
