from __future__ import annotations

from pathlib import Path

from src.orchestrator.skill_registry import list_installed_skill_registry
from src.orchestrator.state import MissingCapability
from src.orchestrator.tool_registry import search_tool_registry


def _write(path: Path, content: str = "") -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")


def test_search_tool_registry_normalizes_registry_result(monkeypatch) -> None:
    monkeypatch.setattr(
        "src.orchestrator.tool_registry._search_registry",
        lambda query: "foo/browser-helper@browser-helper",
    )
    missing = MissingCapability(
        intent="authenticated_browser_session",
        reason="Need a logged-in browser",
        required_capabilities=[],
        preferred_sources=["cli"],
    )
    entries = search_tool_registry("browser helper", missing_capability=missing)
    assert len(entries) == 1
    entry = entries[0]
    assert entry.registry_name == "foo/browser-helper@browser-helper"
    assert entry.source_type == "cli"
    assert entry.install_path == "tool_installer"
    assert entry.to_dict()["displayName"] == "browser-helper"
    assert entry.provider_id == "foo/browser-helper"
    assert entry.package_id == "foo/browser-helper@browser-helper"
    assert entry.tool_id == "cli:foo-browser-helper:browser-helper"


def test_search_tool_registry_tries_fallback_queries_and_deduplicates(monkeypatch) -> None:
    calls: list[str] = []

    def _fake_search(query: str) -> str | None:
        calls.append(query)
        if query == "authenticated_browser_session":
            return "foo/browser-helper@browser-helper"
        if query == "browser auth":
            return "foo/browser-helper@browser-helper"
        return None

    monkeypatch.setattr("src.orchestrator.tool_registry._search_registry", _fake_search)

    missing = MissingCapability(
        intent="authenticated_browser_session",
        reason="browser auth",
        required_capabilities=["browser", "auth"],
        preferred_sources=["cli"],
    )

    entries = search_tool_registry("", missing_capability=missing)

    assert calls[0] == "authenticated_browser_session"
    assert len(entries) == 1
    assert entries[0].metadata["registry_query"] == "authenticated_browser_session"


def test_list_installed_skill_registry_reads_index(tmp_path: Path) -> None:
    skills_root = tmp_path / "skills"
    _write(skills_root / "sample" / "SKILL.md", "# Sample Skill\n")
    rows = list_installed_skill_registry(skills_root)
    assert rows == []

    from src.skills.index_manager import SkillsIndexManager

    SkillsIndexManager(skills_root).reindex(scope="full")
    rows = list_installed_skill_registry(skills_root)
    assert len(rows) == 1
    assert rows[0].skill_id == "sample"
    assert rows[0].skill_name == "sample"
