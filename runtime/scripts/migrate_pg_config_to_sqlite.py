#!/usr/bin/env python3
"""Migrate tools/mcp config from API Postgres to runtime SQLite.

Usage:
  cd runtime
  .venv/bin/python scripts/migrate_pg_config_to_sqlite.py \
    --database-url postgresql://localhost:5432/semibot

Notes:
- Target SQLite defaults to ~/.semibot/semibot.db
- This script only migrates: tools, mcp_servers, agent_mcp_servers
- It does not migrate sessions/events business data
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
from datetime import datetime
from pathlib import Path
from typing import Any

import asyncpg

ROOT_DIR = Path(__file__).resolve().parents[1]
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

from src.server.config_store import RuntimeConfigStore  # noqa: E402


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


def _to_iso(value: Any) -> str:
    if isinstance(value, datetime):
        return value.isoformat()
    return datetime.now().isoformat()


async def _table_exists(conn: asyncpg.Connection, table_name: str) -> bool:
    row = await conn.fetchrow("SELECT to_regclass($1) as reg", table_name)
    return bool(row and row.get("reg"))


async def _fetch_tools(conn: asyncpg.Connection) -> list[dict[str, Any]]:
    if not await _table_exists(conn, "public.tools"):
        return []
    rows = await conn.fetch(
        """
        SELECT
          id::text as id,
          org_id::text as org_id,
          name,
          description,
          type,
          schema::text as schema_json,
          config::text as config_json,
          is_builtin,
          is_active,
          created_by::text as created_by,
          created_at,
          updated_at
        FROM tools
        WHERE deleted_at IS NULL
        ORDER BY is_builtin DESC, name ASC
        """
    )
    return [dict(row) for row in rows]


async def _fetch_mcp_servers(conn: asyncpg.Connection) -> list[dict[str, Any]]:
    if not await _table_exists(conn, "public.mcp_servers"):
        return []
    rows = await conn.fetch(
        """
        SELECT
          id::text as id,
          org_id::text as org_id,
          name,
          description,
          endpoint,
          transport,
          auth_type,
          auth_config::text as auth_config_json,
          tools::text as tools_json,
          resources::text as resources_json,
          status,
          last_connected_at,
          is_active,
          is_system,
          created_by::text as created_by,
          created_at,
          updated_at
        FROM mcp_servers
        WHERE deleted_at IS NULL
        ORDER BY created_at DESC
        """
    )
    return [dict(row) for row in rows]


async def _fetch_agent_mcp_links(conn: asyncpg.Connection) -> list[dict[str, Any]]:
    if not await _table_exists(conn, "public.agent_mcp_servers"):
        return []
    rows = await conn.fetch(
        """
        SELECT
          agent_id::text as agent_id,
          mcp_server_id::text as mcp_server_id,
          enabled_tools::text as enabled_tools_json,
          enabled_resources::text as enabled_resources_json,
          is_active,
          created_at,
          updated_at
        FROM agent_mcp_servers
        ORDER BY agent_id ASC, mcp_server_id ASC
        """
    )
    return [dict(row) for row in rows]


def _clear_target(store: RuntimeConfigStore) -> None:
    with store._connect() as conn:  # noqa: SLF001
        conn.execute("DELETE FROM agent_mcp_servers")
        conn.execute("DELETE FROM mcp_servers")
        conn.execute("DELETE FROM tool_configs")


async def run(args: argparse.Namespace) -> int:
    database_url = args.database_url or os.getenv("DATABASE_URL")
    if not database_url:
        print("ERROR: missing --database-url and DATABASE_URL", file=sys.stderr)
        return 2

    sqlite_path = str(Path(args.sqlite_path).expanduser())
    store = RuntimeConfigStore(db_path=sqlite_path)

    conn = await asyncpg.connect(database_url)
    try:
        tools = await _fetch_tools(conn)
        mcp_servers = await _fetch_mcp_servers(conn)
        links = await _fetch_agent_mcp_links(conn)
    finally:
        await conn.close()

    print(f"Source rows: tools={len(tools)}, mcp_servers={len(mcp_servers)}, agent_mcp_links={len(links)}")

    if args.dry_run:
        print("Dry run only. No write performed.")
        return 0

    if args.clear_existing:
        _clear_target(store)

    migrated_tools = 0
    for row in tools:
        name = str(row.get("name") or "").strip()
        if not name:
            continue
        item = store.upsert_tool_by_name(
            name,
            {
                "description": row.get("description"),
                "type": row.get("type") or "builtin",
                "schema": _json_loads(row.get("schema_json"), {}),
                "config": _json_loads(row.get("config_json"), {}),
                "is_builtin": bool(row.get("is_builtin", False)),
                "is_active": bool(row.get("is_active", True)),
                "org_id": row.get("org_id"),
                "created_by": row.get("created_by"),
            },
        )
        if row.get("id") and item.get("id") != row["id"]:
            # Preserve old ID when creating from clean DB; for existing rows keep current ID.
            existing = store.get_tool_by_id(item["id"])
            if existing and not store.get_tool_by_id(str(row["id"])):
                with store._connect() as sql_conn:  # noqa: SLF001
                    sql_conn.execute(
                        "UPDATE tool_configs SET id = ?, updated_at = ? WHERE id = ?",
                        (str(row["id"]), _to_iso(row.get("updated_at")), item["id"]),
                    )
        migrated_tools += 1

    migrated_mcp = 0
    for row in mcp_servers:
        sid = str(row.get("id") or "").strip()
        if not sid:
            continue

        existing = store.get_mcp_server(sid)
        payload = {
            "id": sid,
            "org_id": row.get("org_id"),
            "name": row.get("name"),
            "description": row.get("description"),
            "endpoint": row.get("endpoint"),
            "transport": row.get("transport") or "streamable_http",
            "auth_type": row.get("auth_type"),
            "auth_config": _json_loads(row.get("auth_config_json"), None),
            "tools": _json_loads(row.get("tools_json"), []),
            "resources": _json_loads(row.get("resources_json"), []),
            "status": row.get("status") or "disconnected",
            "last_connected_at": _to_iso(row.get("last_connected_at")) if row.get("last_connected_at") else None,
            "is_active": bool(row.get("is_active", True)),
            "is_system": bool(row.get("is_system", False)),
            "created_by": row.get("created_by"),
        }

        if existing:
            store.update_mcp_server(sid, payload)
        else:
            store.create_mcp_server(payload)
        migrated_mcp += 1

    migrated_links = 0
    normalized_links: list[dict[str, Any]] = []
    for row in links:
        aid = str(row.get("agent_id") or "").strip()
        sid = str(row.get("mcp_server_id") or "").strip()
        if not aid or not sid:
            continue
        normalized_links.append(
            {
                "agent_id": aid,
                "mcp_server_id": sid,
                "enabled_tools": _json_loads(row.get("enabled_tools_json"), []),
                "enabled_resources": _json_loads(row.get("enabled_resources_json"), []),
                "is_active": bool(row.get("is_active", True)),
                "created_at": _to_iso(row.get("created_at")),
                "updated_at": _to_iso(row.get("updated_at")),
            }
        )
        migrated_links += 1

    store.replace_agent_mcp_rows(normalized_links)

    print(
        f"Migrated rows: tools={migrated_tools}, mcp_servers={migrated_mcp}, "
        f"agent_mcp_links={migrated_links} -> sqlite={sqlite_path}"
    )
    return 0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Migrate Postgres tools/mcp config to runtime SQLite")
    parser.add_argument(
        "--database-url",
        default="",
        help="Postgres DATABASE_URL (fallback to env DATABASE_URL)",
    )
    parser.add_argument(
        "--sqlite-path",
        default="~/.semibot/semibot.db",
        help="Target sqlite file path (default: ~/.semibot/semibot.db)",
    )
    parser.add_argument(
        "--clear-existing",
        action="store_true",
        help="Clear existing local tool/mcp config before migrate",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Read source rows and print counts only, do not write",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    try:
        return asyncio.run(run(args))
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
