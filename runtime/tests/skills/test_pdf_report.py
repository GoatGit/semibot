"""Tests for pdf_report builtin tool."""

import pytest

from src.skills.pdf_report import PdfReportTool


@pytest.mark.asyncio
async def test_pdf_report_generates_file_metadata() -> None:
    tool = PdfReportTool()
    result = await tool.execute(
        filename="unit-test-report.pdf",
        title="Unit Test Report",
        summary="This is a generated report.",
        sections=[{"heading": "Section A", "bullet_points": ["Item 1", "Item 2"]}],
        conclusion="Done.",
    )
    assert result.success is True
    generated_files = (result.metadata or {}).get("generated_files", [])
    assert isinstance(generated_files, list)
