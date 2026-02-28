"""Builtin read-only SQL query tool with whitelist and limits."""

from __future__ import annotations

import asyncio
import os
import re
import sqlite3
from pathlib import Path
from typing import Any

try:
    import asyncpg
except Exception:  # pragma: no cover - optional dependency safety
    asyncpg = None  # type: ignore[assignment]

from src.server.config_store import RuntimeConfigStore
from src.skills.base import BaseTool, ToolResult

_FORBIDDEN_SQL_RE = re.compile(
    r"\b("
    r"insert|update|delete|drop|alter|truncate|create|grant|revoke|merge|call|execute|copy|"
    r"attach|detach|pragma|vacuum|reindex|analyze"
    r")\b",
    flags=re.IGNORECASE,
)


def _strip_sql_comments(query: str) -> str:
    no_block = re.sub(r"/\*.*?\*/", "", query, flags=re.DOTALL)
    no_line = re.sub(r"--.*?$", "", no_block, flags=re.MULTILINE)
    return no_line.strip()


def _safe_json_value(value: Any) -> Any:
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, (bytes, bytearray)):
        return value.decode("utf-8", errors="replace")
    if isinstance(value, (list, tuple)):
        return [_safe_json_value(item) for item in value]
    if isinstance(value, dict):
        return {str(k): _safe_json_value(v) for k, v in value.items()}
    return str(value)


class SqlQueryReadonlyTool(BaseTool):
    """Execute read-only SQL on explicitly configured and whitelisted data sources."""

    def __init__(self) -> None:
        self.default_timeout_ms = int(os.getenv("SEMIBOT_SQL_READ_TIMEOUT_MS", "15000"))
        self.default_max_rows = int(os.getenv("SEMIBOT_SQL_READ_MAX_ROWS", "200"))
        self.default_database = str(os.getenv("SEMIBOT_SQL_READ_DEFAULT_DATABASE", "")).strip()
        self.allowed_databases: set[str] = set()
        self.connections: dict[str, str] = {}
        self._load_runtime_config()

    @property
    def name(self) -> str:
        return "sql_query_readonly"

    @property
    def description(self) -> str:
        return "Run read-only SQL queries with database whitelist, timeout, and row limits."

    @property
    def parameters(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "Read-only SQL query (SELECT/CTE)."},
                "database": {
                    "type": "string",
                    "description": "Target database alias configured in tool config.",
                },
                "params": {
                    "description": "Positional SQL params list for placeholders. Optional.",
                },
                "timeout_ms": {"type": "integer", "description": "Execution timeout in milliseconds."},
                "max_rows": {"type": "integer", "description": "Maximum returned rows."},
            },
            "required": ["query"],
        }

    def _load_runtime_config(self) -> None:
        try:
            store = RuntimeConfigStore(db_path=os.getenv("SEMIBOT_EVENTS_DB_PATH"))
            item = store.get_tool_by_name(self.name)
            config = item.get("config") if isinstance(item, dict) else {}
            if not isinstance(config, dict):
                return

            timeout = config.get("timeout")
            if isinstance(timeout, (int, float)) and timeout > 0:
                self.default_timeout_ms = int(timeout)

            max_rows = config.get("maxRows")
            if isinstance(max_rows, int) and max_rows > 0:
                self.default_max_rows = max_rows

            default_db = config.get("defaultDatabase")
            if isinstance(default_db, str) and default_db.strip():
                self.default_database = default_db.strip()

            allowed = config.get("allowedDatabases")
            if isinstance(allowed, list):
                self.allowed_databases = {str(item).strip() for item in allowed if str(item).strip()}

            connections = config.get("connections")
            if isinstance(connections, dict):
                normalized_connections: dict[str, str] = {}
                for key, value in connections.items():
                    key_text = str(key).strip()
                    value_text = str(value).strip()
                    if key_text and value_text:
                        normalized_connections[key_text] = value_text
                if normalized_connections:
                    self.connections = normalized_connections

            dsn = config.get("dsn") or config.get("databaseUrl") or config.get("apiEndpoint")
            if isinstance(dsn, str) and dsn.strip():
                self.connections.setdefault("default", dsn.strip())

            sqlite_path = config.get("sqlitePath") or config.get("dbPath")
            if isinstance(sqlite_path, str) and sqlite_path.strip():
                self.connections.setdefault("sqlite", sqlite_path.strip())
        except Exception:
            return

    def _validate_query(self, query: str) -> tuple[bool, str | None]:
        clean = _strip_sql_comments(query)
        if not clean:
            return False, "query is empty"
        lowered = clean.lower()
        if not (lowered.startswith("select") or lowered.startswith("with")):
            return False, "Only SELECT/CTE read queries are allowed."
        if _FORBIDDEN_SQL_RE.search(clean):
            return False, "Query contains forbidden SQL keywords for readonly mode."
        if ";" in clean.rstrip(";"):
            return False, "Only a single SQL statement is allowed."
        return True, None

    def _resolve_connection(self, database: str | None) -> tuple[str, str]:
        requested = str(database or "").strip() or self.default_database
        if requested:
            if self.allowed_databases and requested not in self.allowed_databases:
                raise ValueError(f"database '{requested}' is not in allowedDatabases")
            dsn = self.connections.get(requested)
            if not dsn:
                raise ValueError(f"database alias '{requested}' is not configured")
            return requested, dsn

        if self.connections:
            alias = "default" if "default" in self.connections else next(iter(self.connections.keys()))
            if self.allowed_databases and alias not in self.allowed_databases:
                raise ValueError("No allowed database is configured")
            return alias, self.connections[alias]
        raise ValueError("No SQL connection configured for sql_query_readonly")

    def _wrap_limit(self, query: str, max_rows: int) -> str:
        normalized = _strip_sql_comments(query).rstrip(";").strip()
        return f"SELECT * FROM ({normalized}) AS semibot_subquery LIMIT {max_rows}"

    async def _execute_sqlite(
        self,
        dsn: str,
        query: str,
        params: list[Any],
        timeout_ms: int,
    ) -> tuple[list[str], list[dict[str, Any]]]:
        if dsn.startswith("sqlite:///"):
            db_path = Path(dsn[len("sqlite:///"):]).expanduser()
        else:
            db_path = Path(dsn).expanduser()
        resolved = db_path.resolve()

        def _run_query() -> tuple[list[str], list[dict[str, Any]]]:
            conn = sqlite3.connect(str(resolved))
            try:
                conn.row_factory = sqlite3.Row
                cursor = conn.execute(query, tuple(params))
                rows = cursor.fetchall()
                columns = [str(col[0]) for col in (cursor.description or [])]
                out_rows: list[dict[str, Any]] = []
                for row in rows:
                    record: dict[str, Any] = {}
                    for col in columns:
                        record[col] = _safe_json_value(row[col])
                    out_rows.append(record)
                return columns, out_rows
            finally:
                conn.close()

        timeout_seconds = max(1.0, timeout_ms / 1000.0)
        return await asyncio.wait_for(asyncio.to_thread(_run_query), timeout=timeout_seconds)

    async def _execute_postgres(
        self,
        dsn: str,
        query: str,
        params: list[Any],
        timeout_ms: int,
    ) -> tuple[list[str], list[dict[str, Any]]]:
        if asyncpg is None:
            raise RuntimeError("asyncpg is not installed")
        timeout_seconds = max(1.0, timeout_ms / 1000.0)
        conn = await asyncpg.connect(dsn=dsn, timeout=timeout_seconds)
        try:
            stmt_timeout = int(timeout_ms)
            await conn.execute(f"SET statement_timeout = {stmt_timeout}")
            records = await conn.fetch(query, *params)
            if not records:
                return [], []
            columns = list(records[0].keys())
            rows: list[dict[str, Any]] = []
            for record in records:
                row: dict[str, Any] = {}
                for col in columns:
                    row[col] = _safe_json_value(record[col])
                rows.append(row)
            return [str(col) for col in columns], rows
        finally:
            await conn.close()

    async def execute(
        self,
        query: str,
        database: str | None = None,
        params: Any = None,
        timeout_ms: int | None = None,
        max_rows: int | None = None,
        **_: Any,
    ) -> ToolResult:
        self._load_runtime_config()
        query_text = str(query or "").strip()
        valid, error = self._validate_query(query_text)
        if not valid:
            return ToolResult.error_result(error or "Invalid readonly query")

        sql_params: list[Any] = []
        if isinstance(params, list):
            sql_params = params
        elif params is not None:
            return ToolResult.error_result("params must be a list for positional SQL parameters")

        timeout_value = (
            timeout_ms
            if isinstance(timeout_ms, int) and timeout_ms > 0
            else self.default_timeout_ms
        )
        max_rows_value = (
            max_rows
            if isinstance(max_rows, int) and max_rows > 0
            else self.default_max_rows
        )
        max_rows_value = min(5000, max_rows_value)

        try:
            alias, dsn = self._resolve_connection(database)
        except Exception as exc:
            return ToolResult.error_result(str(exc))

        wrapped_query = self._wrap_limit(query_text, max_rows_value)

        try:
            dsn_lower = dsn.lower()
            if dsn_lower.startswith("postgresql://") or dsn_lower.startswith("postgres://"):
                columns, rows = await self._execute_postgres(dsn, wrapped_query, sql_params, timeout_value)
                backend = "postgres"
            else:
                columns, rows = await self._execute_sqlite(dsn, wrapped_query, sql_params, timeout_value)
                backend = "sqlite"
        except TimeoutError:
            return ToolResult.error_result("SQL query timed out")
        except Exception as exc:
            return ToolResult.error_result(f"SQL execution failed: {exc}")

        return ToolResult.success_result(
            {
                "database": alias,
                "backend": backend,
                "columns": columns,
                "rows": rows,
                "row_count": len(rows),
                "max_rows": max_rows_value,
            }
        )
