"""Tests for csv_xlsx builtin tool."""

from __future__ import annotations

import pytest

from src.skills.csv_xlsx import CsvXlsxTool


@pytest.mark.asyncio
async def test_csv_xlsx_write_then_read_csv(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("SEMIBOT_CSV_XLSX_ROOT", str(tmp_path))
    tool = CsvXlsxTool()

    write_result = await tool.execute(
        action="write",
        output_path="reports/data.csv",
        data=[{"name": "Alice", "score": 90}, {"name": "Bob", "score": 80}],
    )
    assert write_result.success is True
    assert "rows_written" in write_result.result

    read_result = await tool.execute(action="read", path="reports/data.csv")
    assert read_result.success is True
    assert read_result.result["total_rows"] == 2
    assert read_result.result["rows"][0]["name"] == "Alice"


@pytest.mark.asyncio
async def test_csv_xlsx_aggregate_rows() -> None:
    tool = CsvXlsxTool()

    result = await tool.execute(
        action="aggregate",
        data=[
            {"team": "A", "amount": 10},
            {"team": "A", "amount": 15},
            {"team": "B", "amount": 20},
        ],
        group_by=["team"],
        metrics=[{"field": "amount", "op": "sum", "as": "total_amount"}],
    )
    assert result.success is True
    totals = {item["team"]: item["total_amount"] for item in result.result["rows"]}
    assert totals["A"] == 25.0
    assert totals["B"] == 20.0
