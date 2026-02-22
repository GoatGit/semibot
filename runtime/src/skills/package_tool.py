"""Dynamic package-backed tool wrappers."""

from __future__ import annotations

import json
from typing import Any

from src.skills.base import BaseTool, ToolResult
from src.skills.code_executor import CodeExecutorTool


class PackagePythonTool(BaseTool):
    """Wrap a packaged Python script as an executable tool."""

    def __init__(self, skill_name: str, description: str | None, script_content: str) -> None:
        self._skill_name = skill_name
        self._description = description or f"Execute packaged skill: {skill_name}"
        self._script_content = script_content
        self._executor = CodeExecutorTool()

    @property
    def name(self) -> str:
        return self._skill_name

    @property
    def description(self) -> str:
        return self._description

    @property
    def parameters(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "context_data": {"type": "string", "description": "Optional JSON payload for script context"},
            },
            "additionalProperties": True,
        }

    async def execute(self, **kwargs: Any) -> ToolResult:
        context_data = kwargs.get("context_data")
        if not isinstance(context_data, str):
            context_data = json.dumps(kwargs, ensure_ascii=False)
        return await self._executor.execute(
            language="python",
            code=self._script_content,
            context_data=context_data,
        )
