"""Minimal installable tool registry abstraction."""

from __future__ import annotations

from dataclasses import dataclass, field
import re
from typing import Any

from src.orchestrator.state import MissingCapability
from src.skills.skill_installer import _search_registry


_REGISTRY_NAME_PATTERN = re.compile(r"^(?P<owner>[a-zA-Z0-9._-]+)/(?P<repo>[a-zA-Z0-9._-]+)@(?P<skill>[a-zA-Z0-9._-]+)$")


def _slug_token(value: str) -> str:
    normalized = re.sub(r"[^a-zA-Z0-9._-]+", "-", str(value or "").strip()).strip("-_.")
    return normalized or "tool"


def _tool_display_name(registry_name: str) -> str:
    normalized = str(registry_name or "").strip()
    if "@" in normalized:
        return normalized.split("@", 1)[-1]
    if "/" in normalized:
        return normalized.rsplit("/", 1)[-1]
    return normalized


def _parse_registry_name(registry_name: str) -> dict[str, str]:
    normalized = str(registry_name or "").strip()
    match = _REGISTRY_NAME_PATTERN.match(normalized)
    if not match:
        display_name = _tool_display_name(normalized)
        return {
            "owner": "",
            "repo": display_name,
            "skill": display_name,
            "provider_id": display_name,
            "package_id": display_name,
            "display_name": display_name,
        }
    owner = match.group("owner")
    repo = match.group("repo")
    skill = match.group("skill")
    provider_id = f"{owner}/{repo}"
    return {
        "owner": owner,
        "repo": repo,
        "skill": skill,
        "provider_id": provider_id,
        "package_id": normalized,
        "display_name": skill,
    }


def _candidate_queries(
    query: str,
    *,
    missing_capability: MissingCapability | None = None,
) -> list[str]:
    candidates: list[str] = []
    seen: set[str] = set()

    def add(value: str | None) -> None:
        normalized = " ".join(str(value or "").strip().split())
        lowered = normalized.lower()
        if not normalized or lowered in seen:
            return
        seen.add(lowered)
        candidates.append(normalized)

    add(query)
    if missing_capability:
        add(missing_capability.intent)
        for capability in missing_capability.required_capabilities:
            add(capability)
        if missing_capability.required_capabilities:
            add(" ".join(missing_capability.required_capabilities))
        add(missing_capability.reason)
        add(" ".join(
            item
            for item in [
                missing_capability.intent,
                *missing_capability.required_capabilities,
                missing_capability.reason,
            ]
            if str(item or "").strip()
        ))
    return candidates


def _select_source_type(missing_capability: MissingCapability | None) -> str:
    preferred_sources = [
        str(item or "").strip()
        for item in (missing_capability.preferred_sources if missing_capability else [])
        if str(item or "").strip()
    ]
    for candidate in preferred_sources:
        if candidate in {"cli", "mcp", "builtin"}:
            return candidate
    return "cli"


@dataclass(frozen=True)
class ToolRegistryEntry:
    tool_id: str
    registry_name: str
    source_type: str
    install_path: str
    display_name: str
    publisher_id: str
    trusted: bool = True
    official: bool = True
    risk_level: str = "medium"
    provider_id: str | None = None
    package_id: str | None = None
    metadata: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "toolId": self.tool_id,
            "registryName": self.registry_name,
            "sourceType": self.source_type,
            "installPath": self.install_path,
            "displayName": self.display_name,
            "publisherId": self.publisher_id,
            "trusted": self.trusted,
            "official": self.official,
            "riskLevel": self.risk_level,
            "providerId": self.provider_id,
            "packageId": self.package_id,
            "metadata": dict(self.metadata or {}),
        }


def search_tool_registry(
    query: str,
    *,
    missing_capability: MissingCapability | None = None,
) -> list[ToolRegistryEntry]:
    """Return installable tool candidates for a missing capability query."""

    source_type = _select_source_type(missing_capability)
    install_path = "tool_installer" if source_type == "cli" else "skill_installer"
    entries: list[ToolRegistryEntry] = []
    seen_registry_names: set[str] = set()

    for candidate_query in _candidate_queries(str(query or "").strip(), missing_capability=missing_capability):
        registry_name = str(_search_registry(candidate_query) or "").strip()
        if not registry_name or registry_name in seen_registry_names:
            continue
        seen_registry_names.add(registry_name)
        parsed = _parse_registry_name(registry_name)
        provider_slug = _slug_token(parsed["provider_id"])
        display_slug = _slug_token(parsed["display_name"])
        entries.append(
            ToolRegistryEntry(
                tool_id=f"{source_type}:{provider_slug}:{display_slug}",
                registry_name=registry_name,
                source_type=source_type,
                install_path=install_path,
                display_name=parsed["display_name"],
                publisher_id="skills.sh",
                risk_level="medium",
                provider_id=parsed["provider_id"],
                package_id=parsed["package_id"],
                metadata={
                    "recommended_via": "skills.sh",
                    "registry_query": candidate_query,
                    "registry_owner": parsed["owner"],
                    "registry_repo": parsed["repo"],
                    "skill_name": parsed["skill"],
                    "preferred_sources": list(missing_capability.preferred_sources if missing_capability else []),
                },
            )
        )
    return entries
