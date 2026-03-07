#!/usr/bin/env python3
"""Migrate API Postgres agents table to runtime SQLite agent_profiles.

Usage:
  cd runtime
  .venv/bin/python scripts/migrate_pg_agents_to_sqlite.py \
    --database-url postgresql://localhost:5432/semibot

Notes:
- Target SQLite defaults to ~/.semibot/semibot.db
- This script migrates agents only.
- Agent profile extras are stored in metadata_json.
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
    if isinstance(value, str) and value.strip():
        return value
    return datetime.now().isoformat()


async def _table_exists(conn: asyncpg.Connection, table_name: str) -> bool:
    row = await conn.fetchrow("SELECT to_regclass($1) as reg", table_name)
    return bool(row and row.get("reg"))


async def _fetch_agents(conn: asyncpg.Connection) -> list[dict[str, Any]]:
    if not await _table_exists(conn, "public.agents"):
        return []
    rows = await conn.fetch(
        """
        SELECT
          id::text as id,
          org_id::text as org_id,
          name,
          description,
          system_prompt,
          config::text as config_json,
          skills::text as skills_json,
          sub_agents::text as sub_agents_json,
          version,
          is_active,
          is_public,
          is_system,
          runtime_type,
          openclaw_config::text as openclaw_config_json,
          created_at,
          updated_at
        FROM agents
        WHERE deleted_at IS NULL
        ORDER BY updated_at DESC, created_at DESC
        """
    )
    return [dict(row) for row in rows]


async def run(args: argparse.Namespace) -> int:
    database_url = args.database_url or os.getenv("DATABASE_URL")
    if not database_url:
        print("ERROR: missing --database-url and DATABASE_URL", file=sys.stderr)
        return 2

    sqlite_path = str(Path(args.sqlite_path).expanduser())
    store = RuntimeConfigStore(db_path=sqlite_path)

    conn = await asyncpg.connect(database_url)
    try:
        agents = await _fetch_agents(conn)
    finally:
        await conn.close()

    print(f"Source rows: agents={len(agents)}")
    if args.dry_run:
        print("Dry run only. No write performed.")
        return 0

    migrated = 0
    for row in agents:
        config = _json_loads(row.get("config_json"), {})
        metadata = {
            "orgId": row.get("org_id"),
            "skills": _json_loads(row.get("skills_json"), []),
            "subAgents": _json_loads(row.get("sub_agents_json"), []),
            "version": int(row.get("version") or 1),
            "isPublic": bool(row.get("is_public", False)),
            "isSystem": bool(row.get("is_system", False)),
            "runtimeType": str(row.get("runtime_type") or "semigraph"),
            "openclawConfig": _json_loads(row.get("openclaw_config_json"), {}),
            "config": {
                "modelProviderKey": str(config.get("modelProviderKey") or ""),
                "timeoutSeconds": int(config.get("timeoutSeconds") or 120),
                "retryAttempts": int(config.get("retryAttempts") or 3),
                "fallbackModel": str(config.get("fallbackModel") or ""),
                "fallbackProviderKey": str(config.get("fallbackProviderKey") or ""),
            },
        }
        existing = store.get_agent_profile(str(row["id"]))
        payload = {
            "id": str(row["id"]),
            "name": row.get("name"),
            "description": row.get("description"),
            "system_prompt": row.get("system_prompt"),
            "model": config.get("model"),
            "temperature": float(config.get("temperature") or 0.7),
            "max_tokens": int(config.get("maxTokens") or 4096),
            "metadata": metadata,
            "is_active": bool(row.get("is_active", True)),
        }
        if existing:
            store.update_agent_profile(str(row["id"]), payload)
        else:
            store.create_agent_profile(payload)
        migrated += 1

    print(f"Migrated rows: agents={migrated} -> sqlite={sqlite_path}")
    return 0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Migrate Postgres agents to runtime SQLite")
    parser.add_argument("--database-url", default=None, help="Postgres connection string")
    parser.add_argument(
      "--sqlite-path",
      default="~/.semibot/semibot.db",
      help="Target sqlite file path (default: ~/.semibot/semibot.db)",
    )
    parser.add_argument("--dry-run", action="store_true", help="Only inspect source rows")
    return parser.parse_args()


def main() -> int:
    return asyncio.run(run(parse_args()))


if __name__ == "__main__":
    raise SystemExit(main())
