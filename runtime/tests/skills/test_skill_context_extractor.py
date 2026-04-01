from __future__ import annotations

from src.skills.skill_context_extractor import (
    extract_skill_scaffold,
    normalize_skill_context_for_act,
)


def test_extract_skill_scaffold_collects_headings_and_excerpt() -> None:
    skill_md = """# Deep Research

## Preparation
Gather context first.

## Execution
Run the core workflow.

## Validation
Check citations and output quality.
"""

    scaffold = extract_skill_scaffold("deep-research", skill_md)

    assert scaffold["skill_id"] == "deep-research"
    assert scaffold["source_sections"] == ["Deep Research", "Preparation", "Execution", "Validation"]
    assert scaffold["phase_outline"] == ["Deep Research", "Preparation", "Execution", "Validation"]
    assert "Gather context first." in scaffold["content_excerpt"]


def test_normalize_skill_context_for_act_filters_invalid_items() -> None:
    normalized = normalize_skill_context_for_act(
        {
            "skill_id": " deep-research ",
            "execution_rules": [{"id": "rule-1"}, "must cite", 123],
            "quality_checks": [{"id": "check-1"}, None],
            "artifact_rules": ["write report", {"id": "artifact-1"}],
            "replan_triggers": ["missing source", {"id": "trigger-1"}, 9],
            "source_sections": ["Preparation", {"bad": True}],
        }
    )

    assert normalized is not None
    assert normalized["skill_id"] == "deep-research"
    assert normalized["execution_rules"] == [{"id": "rule-1"}, "must cite"]
    assert normalized["quality_checks"] == [{"id": "check-1"}]
    assert normalized["artifact_rules"] == ["write report", {"id": "artifact-1"}]
    assert normalized["replan_triggers"] == ["missing source", {"id": "trigger-1"}]
    assert normalized["source_sections"] == ["Preparation", {"bad": True}]


def test_normalize_skill_context_for_act_returns_none_for_non_dict() -> None:
    assert normalize_skill_context_for_act(None) is None
    assert normalize_skill_context_for_act("bad") is None
