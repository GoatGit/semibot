"""Gateway context persistence store (SQLite)."""

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
                  bot_id TEXT NOT NULL,
                  chat_id TEXT NOT NULL,
                  main_context_id TEXT NOT NULL,
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
                  source_message_id TEXT,
                  snapshot_version INTEGER NOT NULL,
                  status TEXT NOT NULL,
                  result_summary TEXT,
                  result_metadata_json TEXT NOT NULL DEFAULT '{}',
                  created_at TEXT NOT NULL,
                  updated_at TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_gateway_task_runs_conv ON gateway_task_runs(conversation_id);
                CREATE INDEX IF NOT EXISTS idx_gateway_task_runs_runtime_session ON gateway_task_runs(runtime_session_id);
                """
            )

    @staticmethod
    def _conversation_row(row: sqlite3.Row) -> dict[str, Any]:
        return {
            "id": row["id"],
            "provider": row["provider"],
            "gateway_key": row["gateway_key"],
            "bot_id": row["bot_id"],
            "chat_id": row["chat_id"],
            "main_context_id": row["main_context_id"],
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
            "source_message_id": row["source_message_id"],
            "snapshot_version": int(row["snapshot_version"]),
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

    def get_or_create_conversation(
        self,
        *,
        provider: str,
        gateway_key: str,
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
                  id, provider, gateway_key, bot_id, chat_id, main_context_id,
                  latest_context_version, status, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, 0, 'active', ?, ?)
                """,
                (conv_id, provider, gateway_key, bot_id, chat_id, main_context_id, now, now),
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

    def create_task_run(
        self,
        *,
        conversation_id: str,
        runtime_session_id: str,
        snapshot_version: int,
        source_message_id: str | None = None,
        status: str = "queued",
    ) -> dict[str, Any]:
        now = _now_iso()
        run_id = f"grun_{uuid4().hex}"
        with self._connect() as conn:
            conn.execute(
                """
                INSERT INTO gateway_task_runs (
                  id, conversation_id, runtime_session_id, source_message_id,
                  snapshot_version, status, result_summary, result_metadata_json,
                  created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, NULL, '{}', ?, ?)
                """,
                (
                    run_id,
                    conversation_id,
                    runtime_session_id,
                    source_message_id,
                    snapshot_version,
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
    ) -> dict[str, Any] | None:
        now = _now_iso()
        with self._connect() as conn:
            cur = conn.execute(
                """
                UPDATE gateway_task_runs
                SET status = ?, result_summary = ?, result_metadata_json = ?, updated_at = ?
                WHERE id = ?
                """,
                (status, result_summary, _json_dumps(result_metadata or {}), now, run_id),
            )
            if cur.rowcount <= 0:
                return None
            row = conn.execute("SELECT * FROM gateway_task_runs WHERE id = ?", (run_id,)).fetchone()
        return self._run_row(row) if row else None

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

    def list_task_runs(self, conversation_id: str, *, limit: int = 100) -> list[dict[str, Any]]:
        with self._connect() as conn:
            rows = conn.execute(
                """
                SELECT * FROM gateway_task_runs
                WHERE conversation_id = ?
                ORDER BY created_at DESC
                LIMIT ?
                """,
                (conversation_id, limit),
            ).fetchall()
        return [self._run_row(row) for row in rows]

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
