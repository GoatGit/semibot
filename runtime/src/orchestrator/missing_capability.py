"""Helpers for structured missing capability recommendation/install flows."""

from __future__ import annotations

from typing import Any

from src.orchestrator.state import MissingCapability
from src.orchestrator.tool_registry import ToolRegistryEntry
from src.orchestrator.skill_registry import SkillRegistryEntry


def build_missing_capability_query(missing_capability: MissingCapability) -> str:
    parts = [
        missing_capability.intent,
        *missing_capability.required_capabilities,
        missing_capability.reason,
    ]
    return " ".join(str(item or "").strip() for item in parts if str(item or "").strip()).strip()


def build_missing_capability_recommendation(
    missing_capability: MissingCapability,
    *,
    query: str,
    registry_name: str,
    recommended_tools: list[ToolRegistryEntry] | None = None,
    recommended_skills: list[SkillRegistryEntry] | None = None,
) -> dict[str, Any]:
    normalized_registry = str(registry_name or "").strip()
    skill_name = normalized_registry.split("@", 1)[-1] if "@" in normalized_registry else normalized_registry
    tool_rows = [entry.to_dict() for entry in (recommended_tools or [])]
    skill_rows = [entry.to_dict() for entry in (recommended_skills or [])]
    if not skill_rows:
        skill_rows = [
            {
                "skillId": normalized_registry,
                "skillName": skill_name,
                "bundledTools": [],
                "riskLevel": "medium",
                "installPath": "skill_installer",
            }
        ]
    return {
        "resolution_mode": "recommend",
        "missing_capability": missing_capability.model_dump(),
        "query": query,
        "registry_name": normalized_registry,
        "recommended_tools": tool_rows,
        "recommended_skills": skill_rows,
    }
