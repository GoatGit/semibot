"""Tests for sql_query_readonly builtin tool."""

from __future__ import annotations

import sqlite3

import pytest

from src.skills.sql_query_readonly import SqlQueryReadonlyTool


@pytest.mark.asyncio
async def test_sql_query_readonly_blocks_mutating_query() -> None:
    tool = SqlQueryReadonlyTool()
    result = await tool.execute(query="DELETE FROM users")
    assert result.success is False
    assert "read" in (result.error or "").lower() or "forbidden" in (result.error or "").lower()


@pytest.mark.asyncio
async def test_sql_query_readonly_executes_sqlite_select(tmp_path) -> None:
    db_path = tmp_path / "readonly.db"
    conn = sqlite3.connect(db_path)
    try:
        conn.execute("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)")
        conn.execute("INSERT INTO users (name) VALUES ('Alice'), ('Bob')")
        conn.commit()
    finally:
        conn.close()

    tool = SqlQueryReadonlyTool()
    tool.connections = {"main": str(db_path)}
    tool.allowed_databases = {"main"}
    tool.default_database = "main"

    result = await tool.execute(query="SELECT id, name FROM users ORDER BY id", max_rows=10)
    assert result.success is True
    assert result.result["database"] == "main"
    assert result.result["row_count"] == 2
    assert result.result["rows"][0]["name"] == "Alice"
