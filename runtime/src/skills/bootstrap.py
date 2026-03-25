"""Skill registry bootstrap — registers built-in tools at startup."""

import os

from src.server.config_store import RuntimeConfigStore
from src.skills.semi_browser import SemiBrowserTool
from src.skills.code_executor import CodeExecutorTool
from src.skills.cli_importer import register_imported_cli_tools
from src.skills.file_io import FileIOTool
from src.skills.http_client import HttpClientTool
from src.skills.memory import MemoryTool
from src.skills.package_loader import register_installed_package_tools
from src.skills.registry import SkillRegistry
from src.skills.rule_authoring import RuleAuthoringTool
from src.skills.search import SearchTool
from src.skills.skill_installer import SkillInstallerTool
from src.skills.text_processing import TextProcessingTool
from src.skills.web_fetch import WebFetchTool
from src.utils.logging import get_logger

logger = get_logger(__name__)

_CODE_EXECUTOR_DEFAULT_TIMEOUT = 60


def create_default_registry() -> SkillRegistry:
    """Create and populate the default skill registry with built-in tools."""
    registry = SkillRegistry()

    # Always register CodeExecutorTool
    code_timeout = int(os.getenv("CODE_EXECUTOR_TIMEOUT") or str(_CODE_EXECUTOR_DEFAULT_TIMEOUT))
    registry.register_tool(CodeExecutorTool(timeout=code_timeout))
    logger.info("Registered CodeExecutorTool", extra={"timeout": code_timeout})
    registry.register_tool(SearchTool())
    registry.register_tool(FileIOTool())
    registry.register_tool(SemiBrowserTool())
    registry.register_tool(HttpClientTool())
    registry.register_tool(WebFetchTool())
    registry.register_tool(TextProcessingTool())
    registry.register_tool(MemoryTool())
    registry.register_tool(RuleAuthoringTool(tool_name="control_plane", registry=registry))
    registry.register_tool(RuleAuthoringTool(tool_name="rule_authoring", legacy_alias=True, registry=registry))
    registry.register_tool(SkillInstallerTool(registry))
    logger.info(
        "Registered core builtin tools",
        extra={
            "tools": [
                "search",
                "file_io",
                "semi_browser",
                "http_client",
                "web_fetch",
                "text_processing",
                "memory",
                "control_plane",
                "rule_authoring",
                "skill_installer",
            ]
        },
    )
    # Index installed skills under ~/.semibot/skills for discovery/orchestration only.
    load_result = register_installed_package_tools(registry, skills_root=os.getenv("SEMIBOT_SKILLS_PATH", "~/.semibot/skills"))
    if load_result.get("indexed"):
        logger.info(
            "Indexed installed skills",
            extra={"indexed": load_result.get("indexed", [])},
        )
    db_path = str(os.getenv("SEMIBOT_EVENTS_DB_PATH") or "").strip()
    if db_path:
        try:
            imported_rows = RuntimeConfigStore(db_path=db_path).list_active_imported_cli_tools()
            imported_names = register_imported_cli_tools(registry, imported_rows)
            if imported_names:
                logger.info("Registered imported CLI tools", extra={"tools": imported_names})
        except Exception as exc:
            logger.warning("imported_cli_registration_failed", extra={"error": str(exc), "db_path": db_path})

    logger.info(
        "Registry bootstrap complete",
        extra={
            "tools": registry.list_tools(),
            "skills": registry.list_skills(),
        },
    )
    return registry
