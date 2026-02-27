"""Runtime local config store backed by SQLite (~/.semibot/semibot.db)."""

from __future__ import annotations

import json
import sqlite3
from contextlib import contextmanager
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Iterator
from uuid import uuid4


def _now_iso() -> str:
    return datetime.now(UTC).isoformat()


def _json_dumps(value: Any) -> str:
    return json.dumps(value if value is not None else {}, ensure_ascii=False)


def _json_dumps_list(value: Any) -> str:
    return json.dumps(value if value is not None else [], ensure_ascii=False)


def _json_loads(value: Any, default: Any) -> Any:
    if value is None:
        return default
    if isinstance(value, (dict, list)):
        return value
    if isinstance(value, str):
        try:
            return json.loads(value)
        except Exception:
            return default
    return default


class RuntimeConfigStore:
    """Persist tools/mcp config in local sqlite."""

    def __init__(self, db_path: str | None = None):
        default_path = Path("~/.semibot/semibot.db").expanduser()
        self.db_path = Path(db_path).expanduser() if db_path else default_path
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._init_schema()

    @contextmanager
    def _connect(self) -> Iterator[sqlite3.Connection]:
        conn = sqlite3.connect(self.db_path)
        try:
            conn.row_factory = sqlite3.Row
            yield conn
            conn.commit()
        finally:
            conn.close()

    def _init_schema(self) -> None:
        with self._connect() as conn:
            conn.executescript(
                """
                CREATE TABLE IF NOT EXISTS tool_configs (
                  id TEXT PRIMARY KEY,
                  org_id TEXT,
                  name TEXT NOT NULL UNIQUE,
                  description TEXT,
                  type TEXT NOT NULL DEFAULT 'builtin',
                  schema_json TEXT NOT NULL DEFAULT '{}',
                  config_json TEXT NOT NULL DEFAULT '{}',
                  is_builtin INTEGER NOT NULL DEFAULT 1,
                  is_active INTEGER NOT NULL DEFAULT 1,
                  created_by TEXT,
                  created_at TEXT NOT NULL,
                  updated_at TEXT NOT NULL,
                  deleted_at TEXT
                );

                CREATE INDEX IF NOT EXISTS idx_tool_configs_name ON tool_configs(name);
                CREATE INDEX IF NOT EXISTS idx_tool_configs_active ON tool_configs(is_active);

                CREATE TABLE IF NOT EXISTS mcp_servers (
                  id TEXT PRIMARY KEY,
                  org_id TEXT,
                  name TEXT NOT NULL,
                  description TEXT,
                  endpoint TEXT NOT NULL,
                  transport TEXT NOT NULL,
                  auth_type TEXT,
                  auth_config TEXT,
                  tools TEXT NOT NULL DEFAULT '[]',
                  resources TEXT NOT NULL DEFAULT '[]',
                  status TEXT NOT NULL DEFAULT 'disconnected',
                  last_connected_at TEXT,
                  is_active INTEGER NOT NULL DEFAULT 1,
                  is_system INTEGER NOT NULL DEFAULT 0,
                  created_by TEXT,
                  created_at TEXT NOT NULL,
                  updated_at TEXT NOT NULL,
                  deleted_at TEXT
                );

                CREATE INDEX IF NOT EXISTS idx_mcp_servers_name ON mcp_servers(name);
                CREATE INDEX IF NOT EXISTS idx_mcp_servers_active ON mcp_servers(is_active);
                CREATE INDEX IF NOT EXISTS idx_mcp_servers_system ON mcp_servers(is_system);

                CREATE TABLE IF NOT EXISTS agent_mcp_servers (
                  agent_id TEXT NOT NULL,
                  mcp_server_id TEXT NOT NULL,
                  enabled_tools TEXT NOT NULL DEFAULT '[]',
                  enabled_resources TEXT NOT NULL DEFAULT '[]',
                  is_active INTEGER NOT NULL DEFAULT 1,
                  created_at TEXT NOT NULL,
                  updated_at TEXT NOT NULL,
                  PRIMARY KEY (agent_id, mcp_server_id)
                );

                CREATE INDEX IF NOT EXISTS idx_agent_mcp_servers_agent ON agent_mcp_servers(agent_id);
                CREATE INDEX IF NOT EXISTS idx_agent_mcp_servers_server ON agent_mcp_servers(mcp_server_id);
                """
            )

    def _tool_row_to_dict(self, row: sqlite3.Row) -> dict[str, Any]:
        return {
            "id": row["id"],
            "org_id": row["org_id"],
            "name": row["name"],
            "description": row["description"],
            "type": row["type"],
            "schema": _json_loads(row["schema_json"], {}),
            "config": _json_loads(row["config_json"], {}),
            "is_builtin": bool(row["is_builtin"]),
            "is_active": bool(row["is_active"]),
            "created_by": row["created_by"],
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
        }

    def list_tools(
        self,
        *,
        include_builtin: bool = True,
        page: int = 1,
        limit: int = 20,
        search: str | None = None,
        tool_type: str | None = None,
    ) -> dict[str, Any]:
        clauses = ["deleted_at IS NULL"]
        args: list[Any] = []

        if not include_builtin:
            clauses.append("is_builtin = 0")

        if search:
            clauses.append("(name LIKE ? OR description LIKE ?)")
            token = f"%{search}%"
            args.extend([token, token])

        if tool_type:
            clauses.append("type = ?")
            args.append(tool_type)

        where_clause = " AND ".join(clauses)

        with self._connect() as conn:
            count_row = conn.execute(
                f"SELECT COUNT(*) as total FROM tool_configs WHERE {where_clause}",
                tuple(args),
            ).fetchone()
            total = int(count_row["total"] if count_row else 0)
            offset = max(0, (page - 1) * limit)
            rows = conn.execute(
                f"""
                SELECT * FROM tool_configs
                WHERE {where_clause}
                ORDER BY is_builtin DESC, name ASC
                LIMIT ? OFFSET ?
                """,
                (*args, limit, offset),
            ).fetchall()

        total_pages = max(1, (total + limit - 1) // limit) if limit > 0 else 1
        return {
            "data": [self._tool_row_to_dict(row) for row in rows],
            "meta": {
                "total": total,
                "page": page,
                "limit": limit,
                "totalPages": total_pages,
            },
        }

    def get_tool_by_id(self, tool_id: str) -> dict[str, Any] | None:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT * FROM tool_configs WHERE id = ? AND deleted_at IS NULL",
                (tool_id,),
            ).fetchone()
        return self._tool_row_to_dict(row) if row else None

    def get_tool_by_name(self, name: str) -> dict[str, Any] | None:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT * FROM tool_configs WHERE LOWER(name) = LOWER(?) AND deleted_at IS NULL",
                (name,),
            ).fetchone()
        return self._tool_row_to_dict(row) if row else None

    def create_tool(self, payload: dict[str, Any]) -> dict[str, Any]:
        tool_id = str(payload.get("id") or uuid4())
        now = _now_iso()
        with self._connect() as conn:
            conn.execute(
                """
                INSERT INTO tool_configs (
                  id, org_id, name, description, type, schema_json, config_json,
                  is_builtin, is_active, created_by, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    tool_id,
                    payload.get("org_id"),
                    payload["name"],
                    payload.get("description"),
                    payload.get("type") or "builtin",
                    _json_dumps(payload.get("schema") or {}),
                    _json_dumps(payload.get("config") or {}),
                    1 if payload.get("is_builtin", True) else 0,
                    1 if payload.get("is_active", True) else 0,
                    payload.get("created_by"),
                    now,
                    now,
                ),
            )
        return self.get_tool_by_id(tool_id) or {}

    def update_tool(self, tool_id: str, patch: dict[str, Any]) -> dict[str, Any] | None:
        existing = self.get_tool_by_id(tool_id)
        if not existing:
            return None

        merged_config = existing.get("config") or {}
        if "config" in patch and isinstance(patch["config"], dict):
            merged_config = {**merged_config, **patch["config"]}

        now = _now_iso()
        with self._connect() as conn:
            conn.execute(
                """
                UPDATE tool_configs
                SET description = ?,
                    type = ?,
                    schema_json = ?,
                    config_json = ?,
                    is_active = ?,
                    is_builtin = ?,
                    updated_at = ?
                WHERE id = ? AND deleted_at IS NULL
                """,
                (
                    patch.get("description", existing.get("description")),
                    patch.get("type", existing.get("type") or "builtin"),
                    _json_dumps(patch.get("schema", existing.get("schema") or {})),
                    _json_dumps(merged_config),
                    1 if patch.get("is_active", existing.get("is_active", True)) else 0,
                    1 if patch.get("is_builtin", existing.get("is_builtin", True)) else 0,
                    now,
                    tool_id,
                ),
            )
        return self.get_tool_by_id(tool_id)

    def upsert_tool_by_name(self, name: str, patch: dict[str, Any]) -> dict[str, Any]:
        existing = self.get_tool_by_name(name)
        if not existing:
            return self.create_tool({
                "name": name,
                "description": patch.get("description"),
                "type": patch.get("type") or "builtin",
                "schema": patch.get("schema") or {},
                "config": patch.get("config") or {},
                "is_builtin": patch.get("is_builtin", True),
                "is_active": patch.get("is_active", True),
                "created_by": patch.get("created_by"),
                "org_id": patch.get("org_id"),
            })
        updated = self.update_tool(existing["id"], patch)
        return updated or existing

    def soft_delete_tool(self, tool_id: str) -> bool:
        now = _now_iso()
        with self._connect() as conn:
            cur = conn.execute(
                """
                UPDATE tool_configs
                SET deleted_at = ?, is_active = 0, updated_at = ?
                WHERE id = ? AND deleted_at IS NULL
                """,
                (now, now, tool_id),
            )
        return cur.rowcount > 0

    def _mcp_row_to_dict(self, row: sqlite3.Row) -> dict[str, Any]:
        return {
            "id": row["id"],
            "org_id": row["org_id"],
            "name": row["name"],
            "description": row["description"],
            "endpoint": row["endpoint"],
            "transport": row["transport"],
            "auth_type": row["auth_type"],
            "auth_config": _json_loads(row["auth_config"], None),
            "tools": _json_loads(row["tools"], []),
            "resources": _json_loads(row["resources"], []),
            "status": row["status"],
            "last_connected_at": row["last_connected_at"],
            "is_active": bool(row["is_active"]),
            "is_system": bool(row["is_system"]),
            "created_by": row["created_by"],
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
        }

    def create_mcp_server(self, payload: dict[str, Any]) -> dict[str, Any]:
        server_id = str(payload.get("id") or uuid4())
        now = _now_iso()
        with self._connect() as conn:
            conn.execute(
                """
                INSERT INTO mcp_servers (
                  id, org_id, name, description, endpoint, transport,
                  auth_type, auth_config, tools, resources, status,
                  last_connected_at, is_active, is_system, created_by,
                  created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    server_id,
                    payload.get("org_id"),
                    payload["name"],
                    payload.get("description"),
                    payload["endpoint"],
                    payload.get("transport") or "streamable_http",
                    payload.get("auth_type"),
                    _json_dumps(payload.get("auth_config")) if payload.get("auth_config") is not None else None,
                    _json_dumps_list(payload.get("tools")),
                    _json_dumps_list(payload.get("resources")),
                    payload.get("status") or "disconnected",
                    payload.get("last_connected_at"),
                    1 if payload.get("is_active", True) else 0,
                    1 if payload.get("is_system", False) else 0,
                    payload.get("created_by"),
                    now,
                    now,
                ),
            )
        return self.get_mcp_server(server_id) or {}

    def get_mcp_server(self, server_id: str) -> dict[str, Any] | None:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT * FROM mcp_servers WHERE id = ? AND deleted_at IS NULL",
                (server_id,),
            ).fetchone()
        return self._mcp_row_to_dict(row) if row else None

    def list_mcp_servers(
        self,
        *,
        page: int = 1,
        limit: int = 20,
        search: str | None = None,
        status: str | None = None,
        only_active: bool = True,
    ) -> dict[str, Any]:
        clauses = ["deleted_at IS NULL"]
        args: list[Any] = []

        if only_active:
            clauses.append("is_active = 1")

        if search:
            clauses.append("(name LIKE ? OR description LIKE ?)")
            token = f"%{search}%"
            args.extend([token, token])

        if status:
            clauses.append("status = ?")
            args.append(status)

        where_clause = " AND ".join(clauses)

        with self._connect() as conn:
            count_row = conn.execute(
                f"SELECT COUNT(*) as total FROM mcp_servers WHERE {where_clause}",
                tuple(args),
            ).fetchone()
            total = int(count_row["total"] if count_row else 0)
            offset = max(0, (page - 1) * limit)
            rows = conn.execute(
                f"""
                SELECT * FROM mcp_servers
                WHERE {where_clause}
                ORDER BY created_at DESC
                LIMIT ? OFFSET ?
                """,
                (*args, limit, offset),
            ).fetchall()

        total_pages = max(1, (total + limit - 1) // limit) if limit > 0 else 1
        return {
            "data": [self._mcp_row_to_dict(row) for row in rows],
            "meta": {
                "total": total,
                "page": page,
                "limit": limit,
                "totalPages": total_pages,
            },
        }

    def count_mcp_servers(self) -> int:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT COUNT(*) as total FROM mcp_servers WHERE is_active = 1 AND deleted_at IS NULL"
            ).fetchone()
        return int(row["total"] if row else 0)

    def update_mcp_server(self, server_id: str, patch: dict[str, Any]) -> dict[str, Any] | None:
        existing = self.get_mcp_server(server_id)
        if not existing:
            return None

        now = _now_iso()
        merged = {
            **existing,
            **patch,
        }

        with self._connect() as conn:
            conn.execute(
                """
                UPDATE mcp_servers
                SET name = ?,
                    description = ?,
                    endpoint = ?,
                    transport = ?,
                    auth_type = ?,
                    auth_config = ?,
                    tools = ?,
                    resources = ?,
                    status = ?,
                    last_connected_at = ?,
                    is_active = ?,
                    is_system = ?,
                    updated_at = ?
                WHERE id = ? AND deleted_at IS NULL
                """,
                (
                    merged.get("name"),
                    merged.get("description"),
                    merged.get("endpoint"),
                    merged.get("transport"),
                    merged.get("auth_type"),
                    _json_dumps(merged.get("auth_config")) if merged.get("auth_config") is not None else None,
                    _json_dumps_list(merged.get("tools")),
                    _json_dumps_list(merged.get("resources")),
                    merged.get("status") or "disconnected",
                    merged.get("last_connected_at"),
                    1 if merged.get("is_active", True) else 0,
                    1 if merged.get("is_system", False) else 0,
                    now,
                    server_id,
                ),
            )
        return self.get_mcp_server(server_id)

    def soft_delete_mcp_server(self, server_id: str) -> bool:
        now = _now_iso()
        with self._connect() as conn:
            cur = conn.execute(
                """
                UPDATE mcp_servers
                SET deleted_at = ?, is_active = 0, updated_at = ?
                WHERE id = ? AND deleted_at IS NULL
                """,
                (now, now, server_id),
            )
        return cur.rowcount > 0

    def get_agent_mcp_server_ids(self, agent_id: str) -> list[str]:
        with self._connect() as conn:
            rows = conn.execute(
                """
                SELECT mcp_server_id FROM agent_mcp_servers
                WHERE agent_id = ? AND is_active = 1
                ORDER BY mcp_server_id ASC
                """,
                (agent_id,),
            ).fetchall()
        return [str(row["mcp_server_id"]) for row in rows]

    def set_agent_mcp_servers(self, agent_id: str, server_ids: list[str]) -> None:
        now = _now_iso()
        with self._connect() as conn:
            conn.execute("DELETE FROM agent_mcp_servers WHERE agent_id = ?", (agent_id,))
            for server_id in server_ids:
                conn.execute(
                    """
                    INSERT INTO agent_mcp_servers (
                      agent_id, mcp_server_id, enabled_tools, enabled_resources,
                      is_active, created_at, updated_at
                    ) VALUES (?, ?, '[]', '[]', 1, ?, ?)
                    """,
                    (agent_id, server_id, now, now),
                )

    def replace_agent_mcp_rows(self, rows: list[dict[str, Any]]) -> None:
        """Replace all agent<->mcp links with provided rows."""
        now = _now_iso()
        with self._connect() as conn:
            conn.execute("DELETE FROM agent_mcp_servers")
            for row in rows:
                agent_id = str(row.get("agent_id") or "").strip()
                server_id = str(row.get("mcp_server_id") or "").strip()
                if not agent_id or not server_id:
                    continue
                enabled_tools = row.get("enabled_tools")
                enabled_resources = row.get("enabled_resources")
                is_active = bool(row.get("is_active", True))
                created_at = str(row.get("created_at") or now)
                updated_at = str(row.get("updated_at") or now)

                conn.execute(
                    """
                    INSERT INTO agent_mcp_servers (
                      agent_id, mcp_server_id, enabled_tools, enabled_resources,
                      is_active, created_at, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        agent_id,
                        server_id,
                        _json_dumps_list(enabled_tools),
                        _json_dumps_list(enabled_resources),
                        1 if is_active else 0,
                        created_at,
                        updated_at,
                    ),
                )

    def find_mcp_servers_by_agent(self, agent_id: str) -> list[dict[str, Any]]:
        with self._connect() as conn:
            rows = conn.execute(
                """
                SELECT ms.*, ams.enabled_tools, ams.enabled_resources
                FROM agent_mcp_servers ams
                JOIN mcp_servers ms ON ms.id = ams.mcp_server_id
                WHERE ams.agent_id = ?
                  AND ams.is_active = 1
                  AND ms.is_active = 1
                  AND ms.deleted_at IS NULL
                ORDER BY ms.name ASC
                """,
                (agent_id,),
            ).fetchall()

        data: list[dict[str, Any]] = []
        for row in rows:
            item = self._mcp_row_to_dict(row)
            item["enabled_tools"] = _json_loads(row["enabled_tools"], [])
            item["enabled_resources"] = _json_loads(row["enabled_resources"], [])
            data.append(item)
        return data

    def find_system_mcp_servers(self) -> list[dict[str, Any]]:
        with self._connect() as conn:
            rows = conn.execute(
                """
                SELECT * FROM mcp_servers
                WHERE is_system = 1 AND is_active = 1 AND deleted_at IS NULL
                ORDER BY name ASC
                """
            ).fetchall()
        return [self._mcp_row_to_dict(row) for row in rows]

    def find_active_mcp_servers(self) -> list[dict[str, Any]]:
        with self._connect() as conn:
            rows = conn.execute(
                """
                SELECT * FROM mcp_servers
                WHERE is_active = 1 AND deleted_at IS NULL
                ORDER BY name ASC
                """
            ).fetchall()
        return [self._mcp_row_to_dict(row) for row in rows]
