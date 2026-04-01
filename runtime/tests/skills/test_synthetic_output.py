"""Tests for synthetic_output builtin tool."""

import pytest

from src.skills.synthetic_output import SyntheticOutputTool

@pytest.mark.asyncio
async def test_synthetic_output_validates_prebuilt_value_without_llm() -> None:
    tool = SyntheticOutputTool()

    result = await tool.execute(
        schema={
            "type": "object",
            "properties": {"summary": {"type": "string"}},
            "required": ["summary"],
        },
        value={"summary": "done"},
    )

    assert result.success is True
    assert result.result["value"]["summary"] == "done"
    assert result.metadata["source"] == "synthetic_output_validation"


@pytest.mark.asyncio
async def test_synthetic_output_accepts_data_as_value_alias() -> None:
    tool = SyntheticOutputTool()

    result = await tool.execute(
        schema={"type": "object", "properties": {"summary": {"type": "string"}}, "required": ["summary"]},
        data={"summary": "from-data"},
    )

    assert result.success is True
    assert result.result["value"]["summary"] == "from-data"


@pytest.mark.asyncio
async def test_synthetic_output_requires_structured_payload() -> None:
    tool = SyntheticOutputTool()

    result = await tool.execute(
        schema={
            "type": "object",
            "properties": {
                "summary": {"type": "string"},
            },
            "required": ["summary"],
        },
    )

    assert result.success is False
    assert "requires value or data" in (result.error or "")


@pytest.mark.asyncio
async def test_synthetic_output_returns_error_for_invalid_schema() -> None:
    tool = SyntheticOutputTool()

    result = await tool.execute(
        schema={"type": "object", "properties": []},
        value={"summary": "done"},
    )

    assert result.success is False
    assert "invalid schema" in (result.error or "")
