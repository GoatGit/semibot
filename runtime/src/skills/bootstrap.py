"""Skill registry bootstrap — registers built-in tools at startup."""

import os

from src.skills.browser_automation import BrowserAutomationTool
from src.skills.code_executor import CodeExecutorTool
from src.skills.csv_xlsx import CsvXlsxTool
from src.skills.file_generators import PdfGeneratorTool, XlsxGeneratorTool
from src.skills.file_io import FileIOTool
from src.skills.http_client import HttpClientTool
from src.skills.json_transform import JsonTransformTool
from src.skills.pdf_report import PdfReportTool
from src.skills.registry import SkillRegistry
from src.skills.search import SearchTool
from src.skills.sql_query_readonly import SqlQueryReadonlyTool
from src.skills.web_fetch import WebFetchTool
from src.skills.web_search import WebSearchTool
from src.utils.logging import get_logger

logger = get_logger(__name__)

_CODE_EXECUTOR_DEFAULT_TIMEOUT = 60


def create_default_registry() -> SkillRegistry:
    """Create and populate the default skill registry with built-in tools."""
    registry = SkillRegistry()

    # Always register CodeExecutorTool
    code_timeout = int(os.getenv("CODE_EXECUTOR_TIMEOUT", str(_CODE_EXECUTOR_DEFAULT_TIMEOUT)))
    registry.register_tool(CodeExecutorTool(timeout=code_timeout))
    logger.info("Registered CodeExecutorTool", extra={"timeout": code_timeout})
    registry.register_tool(SearchTool())
    registry.register_tool(FileIOTool())
    registry.register_tool(BrowserAutomationTool())
    registry.register_tool(HttpClientTool())
    registry.register_tool(WebFetchTool())
    registry.register_tool(JsonTransformTool())
    registry.register_tool(CsvXlsxTool())
    registry.register_tool(PdfReportTool())
    registry.register_tool(SqlQueryReadonlyTool())
    logger.info(
        "Registered core builtin tools",
        extra={
            "tools": [
                "search",
                "file_io",
                "browser_automation",
                "http_client",
                "web_fetch",
                "json_transform",
                "csv_xlsx",
                "pdf_report",
                "sql_query_readonly",
            ]
        },
    )
    registry.register_tool(XlsxGeneratorTool())
    registry.register_tool(PdfGeneratorTool())
    logger.info("Registered file generator tools", extra={"tools": ["xlsx", "pdf"]})

    # Register WebSearchTool if an API key is available
    tavily_key = os.getenv("TAVILY_API_KEY")
    serpapi_key = os.getenv("SERPAPI_API_KEY")

    if tavily_key:
        registry.register_tool(WebSearchTool(api_key=tavily_key, api_type="tavily"))
        logger.info("Registered WebSearchTool (tavily)")
    elif serpapi_key:
        registry.register_tool(WebSearchTool(api_key=serpapi_key, api_type="serpapi"))
        logger.info("Registered WebSearchTool (serpapi)")
    else:
        logger.info("WebSearchTool not registered (no API key configured)")

    logger.info(
        "Registry bootstrap complete",
        extra={
            "tools": registry.list_tools(),
            "skills": registry.list_skills(),
        },
    )
    return registry
