from src.orchestrator.missing_capability import (
    build_missing_capability_query,
    build_missing_capability_recommendation,
)
from src.orchestrator.tool_registry import ToolRegistryEntry
from src.orchestrator.state import MissingCapability


def test_build_missing_capability_query():
    payload = MissingCapability(
        intent="authenticated_browser_session",
        reason="Need a logged-in browser",
        required_capabilities=["browser", "authenticated_session"],
        preferred_sources=["cli"],
    )

    assert (
        build_missing_capability_query(payload)
        == "authenticated_browser_session browser authenticated_session Need a logged-in browser"
    )


def test_build_missing_capability_recommendation():
    payload = MissingCapability(
        intent="authenticated_browser_session",
        reason="Need a logged-in browser",
        required_capabilities=["browser"],
        preferred_sources=["cli"],
    )

    result = build_missing_capability_recommendation(
        payload,
        query="authenticated_browser_session browser Need a logged-in browser",
        registry_name="foo/browser-helper@cli",
        recommended_tools=[
            ToolRegistryEntry(
                tool_id="cli:browser-helper:browser_search",
                registry_name="foo/browser-helper@cli",
                source_type="cli",
                install_path="tool_installer",
                display_name="browser_search",
                publisher_id="skills.sh",
            )
        ],
    )

    assert result["resolution_mode"] == "recommend"
    assert result["recommended_tools"][0]["toolId"] == "cli:browser-helper:browser_search"
    assert result["recommended_skills"][0]["skillId"] == "foo/browser-helper@cli"
    assert result["recommended_skills"][0]["skillName"] == "cli"


def test_build_missing_capability_recommendation_preserves_explicit_skill_matches():
    payload = MissingCapability(
        intent="authenticated_browser_session",
        reason="Need a logged-in browser",
        required_capabilities=["browser"],
        preferred_sources=["cli"],
    )

    class _SkillEntry:
        def to_dict(self):
            return {
                "skillId": "browser-tools",
                "skillName": "Browser Tools",
                "bundledTools": ["browser_search"],
            }

    result = build_missing_capability_recommendation(
        payload,
        query="authenticated_browser_session browser Need a logged-in browser",
        registry_name="foo/browser-helper@cli",
        recommended_tools=[],
        recommended_skills=[_SkillEntry()],
    )

    assert result["recommended_skills"] == [
        {
            "skillId": "browser-tools",
            "skillName": "Browser Tools",
            "bundledTools": ["browser_search"],
        }
    ]
