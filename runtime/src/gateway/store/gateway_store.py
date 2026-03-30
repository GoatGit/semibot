"""Gateway context persistence store (SQLite)."""

from __future__ import annotations

import asyncio
import json
import logging
import os
import sqlite3
from contextlib import contextmanager
from datetime import UTC, datetime, timedelta
from pathlib import Path
from time import perf_counter
from typing import Any, Iterator
from uuid import uuid4

logger = logging.getLogger(__name__)



def _now_iso() -> str:
    return datetime.now(UTC).isoformat()


def _json_dumps(value: Any) -> str:
    return json.dumps(value if value is not None else {}, ensure_ascii=False)


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


class GatewayStore:
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
                CREATE TABLE IF NOT EXISTS gateway_conversations (
                  id TEXT PRIMARY KEY,
                  provider TEXT NOT NULL,
                  gateway_key TEXT NOT NULL UNIQUE,
                  instance_id TEXT NOT NULL DEFAULT '',
                  bot_id TEXT NOT NULL,
                  chat_id TEXT NOT NULL,
                  main_context_id TEXT NOT NULL,
                  active_runtime_session_id TEXT,
                  active_runtime_session_status TEXT NOT NULL DEFAULT 'idle',
                  active_runtime_forked_from_session_id TEXT,
                  latest_context_version INTEGER NOT NULL DEFAULT 0,
                  status TEXT NOT NULL DEFAULT 'active',
                  created_at TEXT NOT NULL,
                  updated_at TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_gateway_conversations_provider ON gateway_conversations(provider);
                CREATE INDEX IF NOT EXISTS idx_gateway_conversations_chat ON gateway_conversations(chat_id);

                CREATE TABLE IF NOT EXISTS gateway_context_messages (
                  id TEXT PRIMARY KEY,
                  conversation_id TEXT NOT NULL,
                  context_version INTEGER NOT NULL,
                  role TEXT NOT NULL,
                  content TEXT NOT NULL,
                  metadata_json TEXT NOT NULL DEFAULT '{}',
                  created_at TEXT NOT NULL,
                  UNIQUE(conversation_id, context_version)
                );
                CREATE INDEX IF NOT EXISTS idx_gateway_context_messages_conv ON gateway_context_messages(conversation_id);
                CREATE INDEX IF NOT EXISTS idx_gateway_context_messages_created ON gateway_context_messages(created_at);

                CREATE TABLE IF NOT EXISTS gateway_task_runs (
                  id TEXT PRIMARY KEY,
                  conversation_id TEXT NOT NULL,
                  runtime_session_id TEXT NOT NULL,
                  parent_run_id TEXT,
                  title TEXT,
                  source_message_id TEXT,
                  snapshot_version INTEGER NOT NULL,
                  context_strategy TEXT NOT NULL DEFAULT 'fresh',
                  context_snapshot_id TEXT,
                  anchor_id TEXT,
                  archived_at TEXT,
                  approval_binding_json TEXT NOT NULL DEFAULT '{}',
                  status TEXT NOT NULL,
                  result_summary TEXT,
                  result_metadata_json TEXT NOT NULL DEFAULT '{}',
                  created_at TEXT NOT NULL,
                  updated_at TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_gateway_task_runs_conv ON gateway_task_runs(conversation_id);
                CREATE INDEX IF NOT EXISTS idx_gateway_task_runs_runtime_session ON gateway_task_runs(runtime_session_id);

                CREATE TABLE IF NOT EXISTS gateway_context_snapshots (
                  id TEXT PRIMARY KEY,
                  execution_id TEXT NOT NULL,
                  strategy TEXT NOT NULL,
                  schema_version TEXT NOT NULL,
                  source_execution_id TEXT,
                  payload_json TEXT NOT NULL DEFAULT '{}',
                  created_at TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_gateway_context_snapshots_execution ON gateway_context_snapshots(execution_id);

                CREATE TABLE IF NOT EXISTS gateway_interaction_anchors (
                  id TEXT PRIMARY KEY,
                  conversation_id TEXT NOT NULL,
                  execution_id TEXT NOT NULL,
                  provider TEXT NOT NULL,
                  channel_target_id TEXT NOT NULL,
                  channel_message_id TEXT NOT NULL,
                  channel_thread_id TEXT,
                  capability_mode TEXT NOT NULL,
                  created_at TEXT NOT NULL,
                  updated_at TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_gateway_interaction_anchors_execution ON gateway_interaction_anchors(execution_id);
                CREATE INDEX IF NOT EXISTS idx_gateway_interaction_anchors_message ON gateway_interaction_anchors(provider, channel_message_id);

                CREATE TABLE IF NOT EXISTS capability_install_requests (
                  id TEXT PRIMARY KEY,
                  task_id TEXT,
                  session_id TEXT,
                  target_type TEXT NOT NULL,
                  target_id TEXT NOT NULL,
                  approval_mode TEXT NOT NULL,
                  state TEXT NOT NULL,
                  error_text TEXT,
                  metadata_json TEXT NOT NULL DEFAULT '{}',
                  created_at TEXT NOT NULL,
                  updated_at TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_capability_install_requests_target ON capability_install_requests(target_type, target_id);
                CREATE INDEX IF NOT EXISTS idx_capability_install_requests_state ON capability_install_requests(state);
                CREATE INDEX IF NOT EXISTS idx_capability_install_requests_created ON capability_install_requests(created_at);

                CREATE TABLE IF NOT EXISTS tool_usage_events (
                  id TEXT PRIMARY KEY,
                  session_id TEXT NOT NULL,
                  task_run_id TEXT,
                  tool_id TEXT NOT NULL,
                  tool_name TEXT NOT NULL,
                  actual_tool_name TEXT NOT NULL,
                  source_type TEXT NOT NULL,
                  success INTEGER NOT NULL DEFAULT 1,
                  metadata_json TEXT NOT NULL DEFAULT '{}',
                  created_at TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_tool_usage_events_session_created ON tool_usage_events(session_id, created_at DESC);
                CREATE INDEX IF NOT EXISTS idx_tool_usage_events_tool_id ON tool_usage_events(tool_id);
                """
            )
            columns = {
                str(row["name"])
                for row in conn.execute("PRAGMA table_info(gateway_conversations)").fetchall()
            }
            if "instance_id" not in columns:
                conn.execute(
                    "ALTER TABLE gateway_conversations ADD COLUMN instance_id TEXT NOT NULL DEFAULT ''"
                )
                conn.execute(
                    "CREATE INDEX IF NOT EXISTS idx_gateway_conversations_instance ON gateway_conversations(instance_id)"
                )
            if "active_runtime_session_id" not in columns:
                conn.execute(
                    "ALTER TABLE gateway_conversations ADD COLUMN active_runtime_session_id TEXT"
                )
            if "active_runtime_session_status" not in columns:
                conn.execute(
                    "ALTER TABLE gateway_conversations ADD COLUMN active_runtime_session_status TEXT NOT NULL DEFAULT 'idle'"
                )
            if "active_runtime_forked_from_session_id" not in columns:
                conn.execute(
                    "ALTER TABLE gateway_conversations ADD COLUMN active_runtime_forked_from_session_id TEXT"
                )
            conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_gateway_conversations_instance ON gateway_conversations(instance_id)"
            )
            task_run_columns = {
                str(row["name"])
                for row in conn.execute("PRAGMA table_info(gateway_task_runs)").fetchall()
            }
            if "parent_run_id" not in task_run_columns:
                conn.execute("ALTER TABLE gateway_task_runs ADD COLUMN parent_run_id TEXT")
            if "context_strategy" not in task_run_columns:
                conn.execute("ALTER TABLE gateway_task_runs ADD COLUMN context_strategy TEXT NOT NULL DEFAULT 'fresh'")
            if "context_snapshot_id" not in task_run_columns:
                conn.execute("ALTER TABLE gateway_task_runs ADD COLUMN context_snapshot_id TEXT")
            if "anchor_id" not in task_run_columns:
                conn.execute("ALTER TABLE gateway_task_runs ADD COLUMN anchor_id TEXT")
            if "archived_at" not in task_run_columns:
                conn.execute("ALTER TABLE gateway_task_runs ADD COLUMN archived_at TEXT")
            if "title" not in task_run_columns:
                conn.execute("ALTER TABLE gateway_task_runs ADD COLUMN title TEXT")
            if "approval_binding_json" not in task_run_columns:
                conn.execute("ALTER TABLE gateway_task_runs ADD COLUMN approval_binding_json TEXT NOT NULL DEFAULT '{}'")

    @staticmethod
    def _slow_threshold_ms() -> float:
        raw = str(os.getenv("SEMIBOT_GATEWAY_STORE_SLOW_MS", "")).strip()
        try:
            return float(raw) if raw else 50.0
        except ValueError:
            return 50.0

    async def _run_async(self, fn: Any, /, *args: Any, op_name: str | None = None, **kwargs: Any) -> Any:
        started = perf_counter()
        result = await asyncio.to_thread(fn, *args, **kwargs)
        elapsed_ms = (perf_counter() - started) * 1000.0
        threshold = self._slow_threshold_ms()
        if elapsed_ms >= threshold:
            logger.warning(
                "slow_gatewaystore_operation op=%s elapsed_ms=%.1f db_path=%s",
                op_name or getattr(fn, "__name__", "unknown"),
                elapsed_ms,
                self.db_path,
            )
        return result

    @staticmethod
    def _conversation_row(row: sqlite3.Row) -> dict[str, Any]:
        return {
            "id": row["id"],
            "provider": row["provider"],
            "gateway_key": row["gateway_key"],
            "instance_id": row["instance_id"],
            "bot_id": row["bot_id"],
            "chat_id": row["chat_id"],
            "main_context_id": row["main_context_id"],
            "active_runtime_session_id": row["active_runtime_session_id"],
            "active_runtime_session_status": row["active_runtime_session_status"],
            "active_runtime_forked_from_session_id": row["active_runtime_forked_from_session_id"],
            "latest_context_version": int(row["latest_context_version"]),
            "status": row["status"],
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
        }

    @staticmethod
    def _run_row(row: sqlite3.Row) -> dict[str, Any]:
        return {
            "id": row["id"],
            "conversation_id": row["conversation_id"],
            "runtime_session_id": row["runtime_session_id"],
            "parent_run_id": row["parent_run_id"] if "parent_run_id" in row.keys() else None,
            "title": row["title"] if "title" in row.keys() else None,
            "source_message_id": row["source_message_id"],
            "snapshot_version": int(row["snapshot_version"]),
            "context_strategy": row["context_strategy"] if "context_strategy" in row.keys() else "fresh",
            "context_snapshot_id": row["context_snapshot_id"] if "context_snapshot_id" in row.keys() else None,
            "anchor_id": row["anchor_id"] if "anchor_id" in row.keys() else None,
            "archived_at": row["archived_at"] if "archived_at" in row.keys() else None,
            "approval_binding": _json_loads(row["approval_binding_json"], {}) if "approval_binding_json" in row.keys() else {},
            "status": row["status"],
            "result_summary": row["result_summary"],
            "result_metadata": _json_loads(row["result_metadata_json"], {}),
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
        }

    @staticmethod
    def _message_row(row: sqlite3.Row) -> dict[str, Any]:
        return {
            "id": row["id"],
            "conversation_id": row["conversation_id"],
            "context_version": int(row["context_version"]),
            "role": row["role"],
            "content": row["content"],
            "metadata": _json_loads(row["metadata_json"], {}),
            "created_at": row["created_at"],
        }

    @staticmethod
    def _install_request_row(row: sqlite3.Row) -> dict[str, Any]:
        return {
            "id": row["id"],
            "task_id": row["task_id"],
            "session_id": row["session_id"],
            "target_type": row["target_type"],
            "target_id": row["target_id"],
            "approval_mode": row["approval_mode"],
            "state": row["state"],
            "error_text": row["error_text"],
            "metadata": _json_loads(row["metadata_json"], {}),
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
        }

    @staticmethod
    def _tool_usage_row(row: sqlite3.Row) -> dict[str, Any]:
        return {
            "id": row["id"],
            "session_id": row["session_id"],
            "task_run_id": row["task_run_id"],
            "tool_id": row["tool_id"],
            "tool_name": row["tool_name"],
            "actual_tool_name": row["actual_tool_name"],
            "source_type": row["source_type"],
            "success": bool(row["success"]),
            "metadata": _json_loads(row["metadata_json"], {}),
            "created_at": row["created_at"],
        }

    @staticmethod
    def _context_snapshot_row(row: sqlite3.Row) -> dict[str, Any]:
        return {
            "id": row["id"],
            "execution_id": row["execution_id"],
            "strategy": row["strategy"],
            "schema_version": row["schema_version"],
            "source_execution_id": row["source_execution_id"],
            "payload": _json_loads(row["payload_json"], {}),
            "created_at": row["created_at"],
        }

    @staticmethod
    def _anchor_row(row: sqlite3.Row) -> dict[str, Any]:
        return {
            "id": row["id"],
            "conversation_id": row["conversation_id"],
            "execution_id": row["execution_id"],
            "provider": row["provider"],
            "channel_target_id": row["channel_target_id"],
            "channel_message_id": row["channel_message_id"],
            "channel_thread_id": row["channel_thread_id"],
            "capability_mode": row["capability_mode"],
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
        }

    def get_or_create_conversation(
        self,
        *,
        provider: str,
        gateway_key: str,
        instance_id: str,
        bot_id: str,
        chat_id: str,
    ) -> dict[str, Any]:
        now = _now_iso()
        with self._connect() as conn:
            row = conn.execute(
                "SELECT * FROM gateway_conversations WHERE gateway_key = ?",
                (gateway_key,),
            ).fetchone()
            if row:
                return self._conversation_row(row)

            conv_id = f"gconv_{uuid4().hex}"
            main_context_id = f"gctx_{uuid4().hex}"
            conn.execute(
                """
                INSERT INTO gateway_conversations (
                  id, provider, gateway_key, instance_id, bot_id, chat_id, main_context_id,
                  active_runtime_session_id, active_runtime_session_status, active_runtime_forked_from_session_id,
                  latest_context_version, status, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 'idle', NULL, 0, 'active', ?, ?)
                """,
                (conv_id, provider, gateway_key, instance_id, bot_id, chat_id, main_context_id, now, now),
            )
            created = conn.execute(
                "SELECT * FROM gateway_conversations WHERE id = ?",
                (conv_id,),
            ).fetchone()
            if not created:
                raise RuntimeError("failed_to_create_gateway_conversation")
            return self._conversation_row(created)

    def append_context_message(
        self,
        *,
        conversation_id: str,
        role: str,
        content: str,
        metadata: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        now = _now_iso()
        message_id = f"gmsg_{uuid4().hex}"
        with self._connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            row = conn.execute(
                "SELECT latest_context_version FROM gateway_conversations WHERE id = ?",
                (conversation_id,),
            ).fetchone()
            if not row:
                raise ValueError("gateway_conversation_not_found")
            next_version = int(row["latest_context_version"]) + 1
            conn.execute(
                """
                INSERT INTO gateway_context_messages (
                  id, conversation_id, context_version, role, content, metadata_json, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    message_id,
                    conversation_id,
                    next_version,
                    role,
                    content,
                    _json_dumps(metadata or {}),
                    now,
                ),
            )
            conn.execute(
                "UPDATE gateway_conversations SET latest_context_version = ?, updated_at = ? WHERE id = ?",
                (next_version, now, conversation_id),
            )
            message = conn.execute(
                "SELECT * FROM gateway_context_messages WHERE id = ?",
                (message_id,),
            ).fetchone()
        if not message:
            raise RuntimeError("failed_to_append_gateway_context_message")
        return self._message_row(message)

    def get_conversation(self, conversation_id: str) -> dict[str, Any] | None:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT * FROM gateway_conversations WHERE id = ?",
                (conversation_id,),
            ).fetchone()
        return self._conversation_row(row) if row else None

    def set_active_runtime_session(
        self,
        conversation_id: str,
        *,
        runtime_session_id: str | None,
        status: str,
        forked_from_session_id: str | None = None,
    ) -> dict[str, Any] | None:
        now = _now_iso()
        with self._connect() as conn:
            cur = conn.execute(
                """
                UPDATE gateway_conversations
                SET active_runtime_session_id = ?,
                    active_runtime_session_status = ?,
                    active_runtime_forked_from_session_id = ?,
                    updated_at = ?
                WHERE id = ?
                """,
                (runtime_session_id, status, forked_from_session_id, now, conversation_id),
            )
            if cur.rowcount <= 0:
                return None
            row = conn.execute(
                "SELECT * FROM gateway_conversations WHERE id = ?",
                (conversation_id,),
            ).fetchone()
        return self._conversation_row(row) if row else None

    def update_active_runtime_session_status(
        self,
        conversation_id: str,
        *,
        runtime_session_id: str,
        status: str,
    ) -> dict[str, Any] | None:
        now = _now_iso()
        with self._connect() as conn:
            cur = conn.execute(
                """
                UPDATE gateway_conversations
                SET active_runtime_session_status = ?, updated_at = ?
                WHERE id = ? AND active_runtime_session_id = ?
                """,
                (status, now, conversation_id, runtime_session_id),
            )
            if cur.rowcount <= 0:
                return self.get_conversation(conversation_id)
            row = conn.execute(
                "SELECT * FROM gateway_conversations WHERE id = ?",
                (conversation_id,),
            ).fetchone()
        return self._conversation_row(row) if row else None

    def create_task_run(
        self,
        *,
        conversation_id: str,
        runtime_session_id: str,
        snapshot_version: int,
        parent_run_id: str | None = None,
        title: str | None = None,
        source_message_id: str | None = None,
        context_strategy: str = "fresh",
        context_snapshot_id: str | None = None,
        anchor_id: str | None = None,
        approval_binding: dict[str, Any] | None = None,
        status: str = "queued",
    ) -> dict[str, Any]:
        now = _now_iso()
        run_id = f"grun_{uuid4().hex}"
        with self._connect() as conn:
            conn.execute(
                """
                INSERT INTO gateway_task_runs (
                  id, conversation_id, runtime_session_id, parent_run_id, title, source_message_id,
                  snapshot_version, context_strategy, context_snapshot_id, anchor_id, approval_binding_json,
                  status, result_summary, result_metadata_json,
                  created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, '{}', ?, ?)
                """,
                (
                    run_id,
                    conversation_id,
                    runtime_session_id,
                    parent_run_id,
                    title,
                    source_message_id,
                    snapshot_version,
                    context_strategy,
                    context_snapshot_id,
                    anchor_id,
                    _json_dumps(approval_binding or {}),
                    status,
                    now,
                    now,
                ),
            )
            row = conn.execute("SELECT * FROM gateway_task_runs WHERE id = ?", (run_id,)).fetchone()
        if not row:
            raise RuntimeError("failed_to_create_gateway_task_run")
        return self._run_row(row)

    def update_task_run(
        self,
        run_id: str,
        *,
        status: str,
        result_summary: str | None = None,
        result_metadata: dict[str, Any] | None = None,
        parent_run_id: str | None = None,
        title: str | None = None,
        context_strategy: str | None = None,
        context_snapshot_id: str | None = None,
        anchor_id: str | None = None,
        archived_at: str | None = None,
        approval_binding: dict[str, Any] | None = None,
    ) -> dict[str, Any] | None:
        now = _now_iso()
        with self._connect() as conn:
            existing = conn.execute("SELECT * FROM gateway_task_runs WHERE id = ?", (run_id,)).fetchone()
            if not existing:
                return None
            cur = conn.execute(
                """
                UPDATE gateway_task_runs
                SET status = ?, result_summary = ?, result_metadata_json = ?,
                    parent_run_id = ?, title = ?, context_strategy = ?, context_snapshot_id = ?,
                    anchor_id = ?, archived_at = ?, approval_binding_json = ?, updated_at = ?
                WHERE id = ?
                """,
                (
                    status,
                    result_summary,
                    _json_dumps(result_metadata or {}),
                    parent_run_id if parent_run_id is not None else existing["parent_run_id"],
                    title if title is not None else existing["title"],
                    context_strategy if context_strategy is not None else existing["context_strategy"],
                    context_snapshot_id if context_snapshot_id is not None else existing["context_snapshot_id"],
                    anchor_id if anchor_id is not None else existing["anchor_id"],
                    archived_at if archived_at is not None else existing["archived_at"],
                    _json_dumps(
                        approval_binding
                        if approval_binding is not None
                        else _json_loads(existing["approval_binding_json"], {})
                    ),
                    now,
                    run_id,
                ),
            )
            if cur.rowcount <= 0:
                return None
            row = conn.execute("SELECT * FROM gateway_task_runs WHERE id = ?", (run_id,)).fetchone()
        return self._run_row(row) if row else None

    def create_context_snapshot(
        self,
        *,
        execution_id: str,
        strategy: str,
        schema_version: str,
        source_execution_id: str | None = None,
        payload: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        now = _now_iso()
        snapshot_id = f"gctxsnap_{uuid4().hex}"
        with self._connect() as conn:
            conn.execute(
                """
                INSERT INTO gateway_context_snapshots (
                  id, execution_id, strategy, schema_version, source_execution_id, payload_json, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    snapshot_id,
                    execution_id,
                    strategy,
                    schema_version,
                    source_execution_id,
                    _json_dumps(payload or {}),
                    now,
                ),
            )
            row = conn.execute("SELECT * FROM gateway_context_snapshots WHERE id = ?", (snapshot_id,)).fetchone()
        if not row:
            raise RuntimeError("failed_to_create_gateway_context_snapshot")
        return self._context_snapshot_row(row)

    def get_context_snapshot(self, snapshot_id: str) -> dict[str, Any] | None:
        with self._connect() as conn:
            row = conn.execute("SELECT * FROM gateway_context_snapshots WHERE id = ?", (snapshot_id,)).fetchone()
        return self._context_snapshot_row(row) if row else None

    def create_interaction_anchor(
        self,
        *,
        conversation_id: str,
        execution_id: str,
        provider: str,
        channel_target_id: str,
        channel_message_id: str,
        channel_thread_id: str | None = None,
        capability_mode: str = "append_only",
    ) -> dict[str, Any]:
        now = _now_iso()
        anchor_id = f"ganchor_{uuid4().hex}"
        with self._connect() as conn:
            conn.execute(
                """
                INSERT INTO gateway_interaction_anchors (
                  id, conversation_id, execution_id, provider, channel_target_id,
                  channel_message_id, channel_thread_id, capability_mode, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    anchor_id,
                    conversation_id,
                    execution_id,
                    provider,
                    channel_target_id,
                    channel_message_id,
                    channel_thread_id,
                    capability_mode,
                    now,
                    now,
                ),
            )
            row = conn.execute("SELECT * FROM gateway_interaction_anchors WHERE id = ?", (anchor_id,)).fetchone()
        if not row:
            raise RuntimeError("failed_to_create_gateway_interaction_anchor")
        return self._anchor_row(row)

    def get_interaction_anchor(self, anchor_id: str) -> dict[str, Any] | None:
        with self._connect() as conn:
            row = conn.execute("SELECT * FROM gateway_interaction_anchors WHERE id = ?", (anchor_id,)).fetchone()
        return self._anchor_row(row) if row else None

    def get_interaction_anchor_by_execution(self, execution_id: str) -> dict[str, Any] | None:
        with self._connect() as conn:
            row = conn.execute(
                """
                SELECT * FROM gateway_interaction_anchors
                WHERE execution_id = ?
                ORDER BY created_at DESC
                LIMIT 1
                """,
                (execution_id,),
            ).fetchone()
        return self._anchor_row(row) if row else None

    def get_interaction_anchor_by_channel_message(
        self,
        *,
        provider: str,
        channel_message_id: str,
    ) -> dict[str, Any] | None:
        with self._connect() as conn:
            row = conn.execute(
                """
                SELECT * FROM gateway_interaction_anchors
                WHERE provider = ? AND channel_message_id = ?
                ORDER BY created_at DESC
                LIMIT 1
                """,
                (provider, channel_message_id),
            ).fetchone()
        return self._anchor_row(row) if row else None

    def update_interaction_anchor(
        self,
        anchor_id: str,
        *,
        channel_message_id: str | None = None,
        channel_thread_id: str | None = None,
    ) -> dict[str, Any] | None:
        with self._connect() as conn:
            existing = conn.execute(
                "SELECT * FROM gateway_interaction_anchors WHERE id = ?",
                (anchor_id,),
            ).fetchone()
            if not existing:
                return None
            next_message_id = (
                str(channel_message_id).strip()
                if channel_message_id is not None and str(channel_message_id).strip()
                else str(existing["channel_message_id"] or "").strip()
            )
            next_thread_id = (
                str(channel_thread_id).strip()
                if channel_thread_id is not None and str(channel_thread_id).strip()
                else (
                    str(existing["channel_thread_id"] or "").strip()
                    if existing["channel_thread_id"] is not None
                    else None
                )
            )
            conn.execute(
                """
                UPDATE gateway_interaction_anchors
                SET channel_message_id = ?, channel_thread_id = ?, updated_at = ?
                WHERE id = ?
                """,
                (
                    next_message_id,
                    next_thread_id,
                    _now_iso(),
                    anchor_id,
                ),
            )
            row = conn.execute("SELECT * FROM gateway_interaction_anchors WHERE id = ?", (anchor_id,)).fetchone()
        return self._anchor_row(row) if row else None

    def find_task_runs_by_approval_ids(
        self,
        approval_ids: list[str],
        *,
        conversation_id: str | None = None,
        statuses: list[str] | None = None,
        include_archived: bool = False,
    ) -> list[dict[str, Any]]:
        normalized_ids = {str(item).strip() for item in approval_ids if str(item).strip()}
        if not normalized_ids:
            return []
        clauses: list[str] = []
        args: list[Any] = []
        if conversation_id:
            clauses.append("conversation_id = ?")
            args.append(conversation_id)
        if statuses:
            placeholders = ",".join("?" * len(statuses))
            clauses.append(f"status IN ({placeholders})")
            args.extend(statuses)
        if not include_archived:
            clauses.append("archived_at IS NULL")
        where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
        with self._connect() as conn:
            rows = conn.execute(
                f"""
                SELECT * FROM gateway_task_runs
                {where}
                ORDER BY updated_at DESC
                """,
                tuple(args),
            ).fetchall()
        matches: list[dict[str, Any]] = []
        for row in rows:
            item = self._run_row(row)
            binding = item.get("approval_binding") if isinstance(item.get("approval_binding"), dict) else {}
            ids = binding.get("approval_ids") if isinstance(binding.get("approval_ids"), list) else []
            if any(str(candidate).strip() in normalized_ids for candidate in ids):
                matches.append(item)
        return matches

    def get_task_run(self, run_id: str) -> dict[str, Any] | None:
        with self._connect() as conn:
            row = conn.execute("SELECT * FROM gateway_task_runs WHERE id = ?", (run_id,)).fetchone()
        return self._run_row(row) if row else None

    def list_conversations(self, *, provider: str | None = None, limit: int = 100) -> list[dict[str, Any]]:
        where = ""
        args: tuple[Any, ...] = ()
        if provider:
            where = "WHERE provider = ?"
            args = (provider,)
        with self._connect() as conn:
            rows = conn.execute(
                f"SELECT * FROM gateway_conversations {where} ORDER BY updated_at DESC LIMIT ?",
                (*args, limit),
            ).fetchall()
        return [self._conversation_row(row) for row in rows]

    def list_task_runs(
        self,
        conversation_id: str,
        *,
        limit: int = 100,
        include_archived: bool = False,
    ) -> list[dict[str, Any]]:
        archived_clause = "" if include_archived else "AND archived_at IS NULL"
        with self._connect() as conn:
            rows = conn.execute(
                """
                SELECT * FROM gateway_task_runs
                WHERE conversation_id = ?
                  {archived_clause}
                ORDER BY created_at DESC
                LIMIT ?
                """.format(archived_clause=archived_clause),
                (conversation_id, limit),
            ).fetchall()
        return [self._run_row(row) for row in rows]

    def archive_old_task_runs(
        self,
        *,
        retention_days: int = 7,
        statuses: list[str] | None = None,
    ) -> int:
        terminal_statuses = statuses or ["done", "failed", "cancelled"]
        if retention_days <= 0 or not terminal_statuses:
            return 0
        cutoff = (datetime.now(UTC) - timedelta(days=retention_days)).isoformat()
        placeholders = ",".join("?" * len(terminal_statuses))
        now = _now_iso()
        with self._connect() as conn:
            cur = conn.execute(
                f"""
                UPDATE gateway_task_runs
                SET archived_at = ?, updated_at = ?
                WHERE archived_at IS NULL
                  AND status IN ({placeholders})
                  AND updated_at < ?
                """,
                (now, now, *terminal_statuses, cutoff),
            )
            return int(cur.rowcount or 0)

    def batch_latest_task_run(
        self,
        conversation_ids: list[str],
        *,
        include_archived: bool = False,
    ) -> dict[str, dict[str, Any]]:
        """Return the latest task run for each conversation_id in a single query."""
        if not conversation_ids:
            return {}
        placeholders = ",".join("?" * len(conversation_ids))
        archived_clause = "" if include_archived else "AND archived_at IS NULL"
        with self._connect() as conn:
            rows = conn.execute(
                f"""
                SELECT * FROM (
                    SELECT *, ROW_NUMBER() OVER (
                        PARTITION BY conversation_id ORDER BY created_at DESC
                    ) AS _rn
                    FROM gateway_task_runs
                    WHERE conversation_id IN ({placeholders})
                      {archived_clause}
                ) WHERE _rn = 1
                """,
                conversation_ids,
            ).fetchall()
        return {row["conversation_id"]: self._run_row(row) for row in rows}

    def list_context_messages(self, conversation_id: str, *, limit: int = 200) -> list[dict[str, Any]]:
        with self._connect() as conn:
            rows = conn.execute(
                """
                SELECT * FROM gateway_context_messages
                WHERE conversation_id = ?
                ORDER BY context_version ASC
                LIMIT ?
                """,
                (conversation_id, limit),
            ).fetchall()
        return [self._message_row(row) for row in rows]

    def latest_assistant_at(self, conversation_id: str) -> str | None:
        with self._connect() as conn:
            row = conn.execute(
                """
                SELECT created_at FROM gateway_context_messages
                WHERE conversation_id = ? AND role = 'assistant'
                ORDER BY context_version DESC
                LIMIT 1
                """,
                (conversation_id,),
            ).fetchone()
        return str(row["created_at"]) if row else None

    def create_capability_install_request(
        self,
        *,
        task_id: str | None,
        session_id: str | None,
        target_type: str,
        target_id: str,
        approval_mode: str,
        state: str,
        metadata: dict[str, Any] | None = None,
        error_text: str | None = None,
    ) -> dict[str, Any]:
        now = _now_iso()
        request_id = f"cinst_{uuid4().hex}"
        with self._connect() as conn:
            conn.execute(
                """
                INSERT INTO capability_install_requests (
                  id, task_id, session_id, target_type, target_id,
                  approval_mode, state, error_text, metadata_json,
                  created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    request_id,
                    task_id,
                    session_id,
                    target_type,
                    target_id,
                    approval_mode,
                    state,
                    error_text,
                    _json_dumps(metadata or {}),
                    now,
                    now,
                ),
            )
            row = conn.execute(
                "SELECT * FROM capability_install_requests WHERE id = ?",
                (request_id,),
            ).fetchone()
        if not row:
            raise RuntimeError("failed_to_create_capability_install_request")
        return self._install_request_row(row)

    def update_capability_install_request(
        self,
        request_id: str,
        *,
        approval_mode: str | None = None,
        state: str | None = None,
        metadata: dict[str, Any] | None = None,
        error_text: str | None = None,
    ) -> dict[str, Any] | None:
        existing = self.get_capability_install_request(request_id)
        if not existing:
            return None
        merged_metadata = dict(existing.get("metadata") or {})
        if metadata:
            merged_metadata.update(metadata)
        now = _now_iso()
        with self._connect() as conn:
            cur = conn.execute(
                """
                UPDATE capability_install_requests
                SET approval_mode = ?, state = ?, error_text = ?, metadata_json = ?, updated_at = ?
                WHERE id = ?
                """,
                (
                    approval_mode or existing["approval_mode"],
                    state or existing["state"],
                    error_text,
                    _json_dumps(merged_metadata),
                    now,
                    request_id,
                ),
            )
            if cur.rowcount <= 0:
                return None
            row = conn.execute(
                "SELECT * FROM capability_install_requests WHERE id = ?",
                (request_id,),
            ).fetchone()
        return self._install_request_row(row) if row else None

    def append_capability_install_audit_event(
        self,
        request_id: str,
        event: dict[str, Any],
    ) -> dict[str, Any] | None:
        existing = self.get_capability_install_request(request_id)
        if not existing:
            return None
        metadata = dict(existing.get("metadata") or {})
        audit_trail = metadata.get("auditTrail")
        if not isinstance(audit_trail, list):
            audit_trail = []
        normalized_event = dict(event or {})
        normalized_event.setdefault("timestamp", _now_iso())
        audit_trail.append(normalized_event)
        metadata["auditTrail"] = audit_trail[-50:]
        return self.update_capability_install_request(request_id, metadata=metadata)

    def get_capability_install_request(self, request_id: str) -> dict[str, Any] | None:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT * FROM capability_install_requests WHERE id = ?",
                (request_id,),
            ).fetchone()
        return self._install_request_row(row) if row else None

    def list_capability_install_requests(
        self,
        *,
        session_id: str | None = None,
        task_id: str | None = None,
        limit: int = 100,
    ) -> list[dict[str, Any]]:
        where: list[str] = []
        params: list[Any] = []
        if session_id:
            where.append("session_id = ?")
            params.append(session_id)
        if task_id:
            where.append("task_id = ?")
            params.append(task_id)
        sql = """
                SELECT * FROM capability_install_requests
            """
        if where:
            sql += " WHERE " + " AND ".join(where)
        sql += """
                ORDER BY created_at DESC
                LIMIT ?
            """
        params.append(limit)
        with self._connect() as conn:
            rows = conn.execute(sql, tuple(params)).fetchall()
        return [self._install_request_row(row) for row in rows]

    def create_tool_usage_event(
        self,
        *,
        session_id: str,
        task_run_id: str | None,
        tool_id: str,
        tool_name: str,
        actual_tool_name: str,
        source_type: str,
        success: bool,
        metadata: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        event_id = f"tuse_{uuid4().hex}"
        now = _now_iso()
        with self._connect() as conn:
            conn.execute(
                """
                INSERT INTO tool_usage_events (
                  id, session_id, task_run_id, tool_id, tool_name, actual_tool_name,
                  source_type, success, metadata_json, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    event_id,
                    session_id,
                    task_run_id,
                    tool_id,
                    tool_name,
                    actual_tool_name,
                    source_type,
                    1 if success else 0,
                    _json_dumps(metadata or {}),
                    now,
                ),
            )
            row = conn.execute(
                "SELECT * FROM tool_usage_events WHERE id = ?",
                (event_id,),
            ).fetchone()
        if not row:
            raise RuntimeError("failed_to_create_tool_usage_event")
        return self._tool_usage_row(row)

    def list_tool_usage_events(
        self,
        *,
        session_id: str,
        limit: int = 100,
    ) -> list[dict[str, Any]]:
        with self._connect() as conn:
            rows = conn.execute(
                """
                SELECT * FROM tool_usage_events
                WHERE session_id = ?
                ORDER BY created_at DESC
                LIMIT ?
                """,
                (session_id, limit),
            ).fetchall()
        return [self._tool_usage_row(row) for row in rows]

    def summarize_recent_tool_usage(
        self,
        *,
        session_id: str,
        limit: int = 100,
        success_only: bool = True,
    ) -> dict[str, int]:
        events = self.list_tool_usage_events(session_id=session_id, limit=limit)
        summary: dict[str, int] = {}
        for event in events:
            if success_only and not bool(event.get("success")):
                continue
            tool_id = str(event.get("tool_id") or "").strip()
            if not tool_id:
                continue
            summary[tool_id] = int(summary.get(tool_id, 0)) + 1
        return summary

    async def aget_or_create_conversation(
        self,
        *,
        provider: str,
        gateway_key: str,
        instance_id: str,
        bot_id: str,
        chat_id: str,
    ) -> dict[str, Any]:
        return await self._run_async(
            self.get_or_create_conversation,
            provider=provider,
            gateway_key=gateway_key,
            instance_id=instance_id,
            bot_id=bot_id,
            chat_id=chat_id,
            op_name="get_or_create_conversation",
        )

    async def aappend_context_message(
        self,
        *,
        conversation_id: str,
        role: str,
        content: str,
        metadata: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        return await self._run_async(
            self.append_context_message,
            conversation_id=conversation_id,
            role=role,
            content=content,
            metadata=metadata,
            op_name="append_context_message",
        )

    async def aset_active_runtime_session(
        self,
        conversation_id: str,
        *,
        runtime_session_id: str | None,
        status: str,
        forked_from_session_id: str | None = None,
    ) -> dict[str, Any] | None:
        return await self._run_async(
            self.set_active_runtime_session,
            conversation_id,
            runtime_session_id=runtime_session_id,
            status=status,
            forked_from_session_id=forked_from_session_id,
            op_name="set_active_runtime_session",
        )

    async def aupdate_active_runtime_session_status(
        self,
        conversation_id: str,
        *,
        runtime_session_id: str,
        status: str,
    ) -> dict[str, Any] | None:
        return await self._run_async(
            self.update_active_runtime_session_status,
            conversation_id,
            runtime_session_id=runtime_session_id,
            status=status,
            op_name="update_active_runtime_session_status",
        )

    async def acreate_task_run(
        self,
        *,
        conversation_id: str,
        runtime_session_id: str,
        snapshot_version: int,
        parent_run_id: str | None = None,
        title: str | None = None,
        source_message_id: str | None = None,
        context_strategy: str = "fresh",
        context_snapshot_id: str | None = None,
        anchor_id: str | None = None,
        approval_binding: dict[str, Any] | None = None,
        status: str = "queued",
    ) -> dict[str, Any]:
        return await self._run_async(
            self.create_task_run,
            conversation_id=conversation_id,
            runtime_session_id=runtime_session_id,
            snapshot_version=snapshot_version,
            parent_run_id=parent_run_id,
            title=title,
            source_message_id=source_message_id,
            context_strategy=context_strategy,
            context_snapshot_id=context_snapshot_id,
            anchor_id=anchor_id,
            approval_binding=approval_binding,
            status=status,
            op_name="create_task_run",
        )

    async def aupdate_task_run(
        self,
        run_id: str,
        *,
        status: str,
        result_summary: str | None = None,
        result_metadata: dict[str, Any] | None = None,
        parent_run_id: str | None = None,
        title: str | None = None,
        context_strategy: str | None = None,
        context_snapshot_id: str | None = None,
        anchor_id: str | None = None,
        archived_at: str | None = None,
        approval_binding: dict[str, Any] | None = None,
    ) -> dict[str, Any] | None:
        return await self._run_async(
            self.update_task_run,
            run_id,
            status=status,
            result_summary=result_summary,
            result_metadata=result_metadata,
            parent_run_id=parent_run_id,
            title=title,
            context_strategy=context_strategy,
            context_snapshot_id=context_snapshot_id,
            anchor_id=anchor_id,
            archived_at=archived_at,
            approval_binding=approval_binding,
            op_name="update_task_run",
        )

    async def aget_conversation(self, conversation_id: str) -> dict[str, Any] | None:
        return await self._run_async(self.get_conversation, conversation_id, op_name="get_conversation")

    async def aget_task_run(self, run_id: str) -> dict[str, Any] | None:
        return await self._run_async(self.get_task_run, run_id, op_name="get_task_run")

    async def acreate_context_snapshot(
        self,
        *,
        execution_id: str,
        strategy: str,
        schema_version: str,
        source_execution_id: str | None = None,
        payload: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        return await self._run_async(
            self.create_context_snapshot,
            execution_id=execution_id,
            strategy=strategy,
            schema_version=schema_version,
            source_execution_id=source_execution_id,
            payload=payload,
            op_name="create_context_snapshot",
        )

    async def aget_context_snapshot(self, snapshot_id: str) -> dict[str, Any] | None:
        return await self._run_async(self.get_context_snapshot, snapshot_id, op_name="get_context_snapshot")

    async def acreate_interaction_anchor(
        self,
        *,
        conversation_id: str,
        execution_id: str,
        provider: str,
        channel_target_id: str,
        channel_message_id: str,
        channel_thread_id: str | None = None,
        capability_mode: str = "append_only",
    ) -> dict[str, Any]:
        return await self._run_async(
            self.create_interaction_anchor,
            conversation_id=conversation_id,
            execution_id=execution_id,
            provider=provider,
            channel_target_id=channel_target_id,
            channel_message_id=channel_message_id,
            channel_thread_id=channel_thread_id,
            capability_mode=capability_mode,
            op_name="create_interaction_anchor",
        )

    async def aget_interaction_anchor(self, anchor_id: str) -> dict[str, Any] | None:
        return await self._run_async(self.get_interaction_anchor, anchor_id, op_name="get_interaction_anchor")

    async def aget_interaction_anchor_by_execution(self, execution_id: str) -> dict[str, Any] | None:
        return await self._run_async(
            self.get_interaction_anchor_by_execution,
            execution_id,
            op_name="get_interaction_anchor_by_execution",
        )

    async def aget_interaction_anchor_by_channel_message(
        self,
        *,
        provider: str,
        channel_message_id: str,
    ) -> dict[str, Any] | None:
        return await self._run_async(
            self.get_interaction_anchor_by_channel_message,
            provider=provider,
            channel_message_id=channel_message_id,
            op_name="get_interaction_anchor_by_channel_message",
        )

    async def aupdate_interaction_anchor(
        self,
        anchor_id: str,
        *,
        channel_message_id: str | None = None,
        channel_thread_id: str | None = None,
    ) -> dict[str, Any] | None:
        return await self._run_async(
            self.update_interaction_anchor,
            anchor_id,
            channel_message_id=channel_message_id,
            channel_thread_id=channel_thread_id,
            op_name="update_interaction_anchor",
        )

    async def afind_task_runs_by_approval_ids(
        self,
        approval_ids: list[str],
        *,
        conversation_id: str | None = None,
        statuses: list[str] | None = None,
        include_archived: bool = False,
    ) -> list[dict[str, Any]]:
        return await self._run_async(
            self.find_task_runs_by_approval_ids,
            approval_ids,
            conversation_id=conversation_id,
            statuses=statuses,
            include_archived=include_archived,
            op_name="find_task_runs_by_approval_ids",
        )

    async def alist_conversations(
        self,
        *,
        provider: str | None = None,
        limit: int = 100,
    ) -> list[dict[str, Any]]:
        return await self._run_async(self.list_conversations, provider=provider, limit=limit, op_name="list_conversations")

    async def alist_task_runs(
        self,
        conversation_id: str,
        *,
        limit: int = 100,
        include_archived: bool = False,
    ) -> list[dict[str, Any]]:
        return await self._run_async(
            self.list_task_runs,
            conversation_id,
            limit=limit,
            include_archived=include_archived,
            op_name="list_task_runs",
        )

    async def aarchive_old_task_runs(
        self,
        *,
        retention_days: int = 7,
        statuses: list[str] | None = None,
    ) -> int:
        return await self._run_async(
            self.archive_old_task_runs,
            retention_days=retention_days,
            statuses=statuses,
            op_name="archive_old_task_runs",
        )

    async def abatch_latest_task_run(
        self,
        conversation_ids: list[str],
        *,
        include_archived: bool = False,
    ) -> dict[str, dict[str, Any]]:
        return await self._run_async(
            self.batch_latest_task_run,
            conversation_ids,
            include_archived=include_archived,
            op_name="batch_latest_task_run",
        )

    async def alist_context_messages(
        self,
        conversation_id: str,
        *,
        limit: int = 200,
    ) -> list[dict[str, Any]]:
        return await self._run_async(self.list_context_messages, conversation_id, limit=limit, op_name="list_context_messages")

    async def alatest_assistant_at(self, conversation_id: str) -> str | None:
        return await self._run_async(self.latest_assistant_at, conversation_id, op_name="latest_assistant_at")

    async def acreate_capability_install_request(
        self,
        *,
        task_id: str | None,
        session_id: str | None,
        target_type: str,
        target_id: str,
        approval_mode: str,
        state: str,
        metadata: dict[str, Any] | None = None,
        error_text: str | None = None,
    ) -> dict[str, Any]:
        return await self._run_async(
            self.create_capability_install_request,
            task_id=task_id,
            session_id=session_id,
            target_type=target_type,
            target_id=target_id,
            approval_mode=approval_mode,
            state=state,
            metadata=metadata,
            error_text=error_text,
            op_name="create_capability_install_request",
        )

    async def aupdate_capability_install_request(
        self,
        request_id: str,
        *,
        approval_mode: str | None = None,
        state: str | None = None,
        metadata: dict[str, Any] | None = None,
        error_text: str | None = None,
    ) -> dict[str, Any] | None:
        return await self._run_async(
            self.update_capability_install_request,
            request_id,
            approval_mode=approval_mode,
            state=state,
            metadata=metadata,
            error_text=error_text,
            op_name="update_capability_install_request",
        )

    async def aget_capability_install_request(self, request_id: str) -> dict[str, Any] | None:
        return await self._run_async(
            self.get_capability_install_request,
            request_id,
            op_name="get_capability_install_request",
        )

    async def alist_capability_install_requests(self, *, limit: int = 100) -> list[dict[str, Any]]:
        return await self._run_async(
            self.list_capability_install_requests,
            limit=limit,
            op_name="list_capability_install_requests",
        )

    async def afilter_capability_install_requests(
        self,
        *,
        session_id: str | None = None,
        task_id: str | None = None,
        limit: int = 100,
    ) -> list[dict[str, Any]]:
        return await self._run_async(
            self.list_capability_install_requests,
            session_id=session_id,
            task_id=task_id,
            limit=limit,
            op_name="list_capability_install_requests",
        )

    async def aappend_capability_install_audit_event(
        self,
        request_id: str,
        event: dict[str, Any],
    ) -> dict[str, Any] | None:
        return await self._run_async(
            self.append_capability_install_audit_event,
            request_id,
            event,
            op_name="append_capability_install_audit_event",
        )

    async def acreate_tool_usage_event(
        self,
        *,
        session_id: str,
        task_run_id: str | None,
        tool_id: str,
        tool_name: str,
        actual_tool_name: str,
        source_type: str,
        success: bool,
        metadata: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        return await self._run_async(
            self.create_tool_usage_event,
            session_id=session_id,
            task_run_id=task_run_id,
            tool_id=tool_id,
            tool_name=tool_name,
            actual_tool_name=actual_tool_name,
            source_type=source_type,
            success=success,
            metadata=metadata,
            op_name="create_tool_usage_event",
        )

    async def alist_tool_usage_events(
        self,
        *,
        session_id: str,
        limit: int = 100,
    ) -> list[dict[str, Any]]:
        return await self._run_async(
            self.list_tool_usage_events,
            session_id=session_id,
            limit=limit,
            op_name="list_tool_usage_events",
        )

    async def asummarize_recent_tool_usage(
        self,
        *,
        session_id: str,
        limit: int = 100,
        success_only: bool = True,
    ) -> dict[str, int]:
        return await self._run_async(
            self.summarize_recent_tool_usage,
            session_id=session_id,
            limit=limit,
            success_only=success_only,
            op_name="summarize_recent_tool_usage",
        )
