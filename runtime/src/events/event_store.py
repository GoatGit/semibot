"""SQLite-backed storage for event-engine artifacts."""

from __future__ import annotations

import json
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterator

from src.events.models import ApprovalRequest, Event, RuleRun


class DuplicateEventError(RuntimeError):
    """Raised when an event idempotency key already exists."""


def _to_iso(value: datetime | None) -> str | None:
    if value is None:
        return None
    return value.astimezone(timezone.utc).isoformat()


def _from_iso(value: str | None) -> datetime | None:
    if not value:
        return None
    return datetime.fromisoformat(value)


class EventStore:
    """Persist events, rule-runs, and approvals in SQLite."""

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
                CREATE TABLE IF NOT EXISTS events (
                  id TEXT PRIMARY KEY,
                  event_type TEXT NOT NULL,
                  source TEXT NOT NULL,
                  subject TEXT,
                  idempotency_key TEXT UNIQUE,
                  payload TEXT NOT NULL,
                  risk_hint TEXT,
                  created_at TEXT NOT NULL
                );

                CREATE INDEX IF NOT EXISTS idx_events_type ON events(event_type);
                CREATE INDEX IF NOT EXISTS idx_events_created_at ON events(created_at);

                CREATE TABLE IF NOT EXISTS event_rule_runs (
                  id TEXT PRIMARY KEY,
                  rule_id TEXT NOT NULL,
                  event_id TEXT NOT NULL,
                  decision TEXT NOT NULL,
                  reason TEXT,
                  status TEXT NOT NULL,
                  action_trace_id TEXT,
                  duration_ms INTEGER,
                  created_at TEXT NOT NULL
                );

                CREATE INDEX IF NOT EXISTS idx_rule_runs_rule ON event_rule_runs(rule_id);
                CREATE INDEX IF NOT EXISTS idx_rule_runs_event ON event_rule_runs(event_id);

                CREATE TABLE IF NOT EXISTS approval_requests (
                  id TEXT PRIMARY KEY,
                  rule_id TEXT NOT NULL,
                  event_id TEXT NOT NULL,
                  risk_level TEXT NOT NULL,
                  status TEXT NOT NULL,
                  created_at TEXT NOT NULL,
                  resolved_at TEXT
                );

                CREATE INDEX IF NOT EXISTS idx_approval_status ON approval_requests(status);
                """
            )

    def append_event(self, event: Event) -> None:
        with self._connect() as conn:
            try:
                conn.execute(
                    """
                    INSERT INTO events (id, event_type, source, subject, idempotency_key, payload, risk_hint, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        event.event_id,
                        event.event_type,
                        event.source,
                        event.subject,
                        event.idempotency_key,
                        json.dumps(event.payload, ensure_ascii=False),
                        event.risk_hint,
                        _to_iso(event.timestamp),
                    ),
                )
            except sqlite3.IntegrityError as exc:
                message = str(exc)
                if "idempotency_key" in message or "events.id" in message:
                    raise DuplicateEventError(str(exc)) from exc
                raise

    def append(self, event: Event) -> None:
        """Compatibility alias for append_event."""
        self.append_event(event)

    def get_event(self, event_id: str) -> Event | None:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT id, event_type, source, subject, payload, idempotency_key, risk_hint, created_at FROM events WHERE id = ?",
                (event_id,),
            ).fetchone()
            if row is None:
                return None
            return Event(
                event_id=row["id"],
                event_type=row["event_type"],
                source=row["source"],
                subject=row["subject"],
                payload=json.loads(row["payload"]),
                timestamp=_from_iso(row["created_at"]) or datetime.now(timezone.utc),
                idempotency_key=row["idempotency_key"],
                risk_hint=row["risk_hint"],
            )

    def get(self, event_id: str) -> Event | None:
        """Compatibility alias for get_event."""
        return self.get_event(event_id)

    def exists_idempotency(self, key: str) -> bool:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT 1 FROM events WHERE idempotency_key = ? LIMIT 1",
                (key,),
            ).fetchone()
            return row is not None

    def has_rule_event_run(self, rule_id: str, event_id: str) -> bool:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT 1 FROM event_rule_runs WHERE rule_id = ? AND event_id = ? LIMIT 1",
                (rule_id, event_id),
            ).fetchone()
            return row is not None

    def has_recent_rule_subject_run(
        self,
        rule_id: str,
        subject: str,
        window_seconds: int,
    ) -> bool:
        if window_seconds <= 0:
            return False

        cutoff = datetime.now(timezone.utc).timestamp() - window_seconds
        cutoff_iso = datetime.fromtimestamp(cutoff, tz=timezone.utc).isoformat()

        with self._connect() as conn:
            row = conn.execute(
                """
                SELECT 1
                FROM event_rule_runs r
                JOIN events e ON e.id = r.event_id
                WHERE r.rule_id = ?
                  AND e.subject = ?
                  AND r.created_at >= ?
                  AND r.decision != 'skip'
                LIMIT 1
                """,
                (rule_id, subject, cutoff_iso),
            ).fetchone()
            return row is not None

    def get_last_rule_run_at(self, rule_id: str) -> datetime | None:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT created_at FROM event_rule_runs WHERE rule_id = ? ORDER BY created_at DESC LIMIT 1",
                (rule_id,),
            ).fetchone()
            return _from_iso(row["created_at"]) if row else None

    def list_events(
        self,
        *,
        limit: int = 100,
        event_type: str | None = None,
        event_types: list[str] | None = None,
        since: datetime | None = None,
    ) -> list[Event]:
        query = """
            SELECT id, event_type, source, subject, payload, idempotency_key, risk_hint, created_at
            FROM events
        """
        clauses: list[str] = []
        args: list[str | int] = []
        normalized_event_types = [
            item.strip()
            for item in (event_types or [])
            if isinstance(item, str) and item.strip()
        ]

        if event_type and not normalized_event_types:
            clauses.append("event_type = ?")
            args.append(event_type)
        elif normalized_event_types:
            placeholders = ", ".join(["?"] * len(normalized_event_types))
            clauses.append(f"event_type IN ({placeholders})")
            args.extend(normalized_event_types)
        if since:
            clauses.append("created_at >= ?")
            args.append(_to_iso(since) or "")
        if clauses:
            query += " WHERE " + " AND ".join(clauses)
        query += " ORDER BY created_at DESC LIMIT ?"
        args.append(limit)

        with self._connect() as conn:
            rows = conn.execute(query, tuple(args)).fetchall()

        return [
            Event(
                event_id=row["id"],
                event_type=row["event_type"],
                source=row["source"],
                subject=row["subject"],
                payload=json.loads(row["payload"]),
                timestamp=_from_iso(row["created_at"]) or datetime.now(timezone.utc),
                idempotency_key=row["idempotency_key"],
                risk_hint=row["risk_hint"],
            )
            for row in rows
        ]

    def list_events_after(
        self,
        *,
        cursor_created_at: str | None = None,
        cursor_event_id: str | None = None,
        limit: int = 100,
        event_type: str | None = None,
        event_types: list[str] | None = None,
    ) -> list[Event]:
        """
        List events after cursor in ascending order for incremental streaming.

        Cursor ordering: (created_at, id).
        """
        query = """
            SELECT id, event_type, source, subject, payload, idempotency_key, risk_hint, created_at
            FROM events
        """
        clauses: list[str] = []
        args: list[str | int] = []

        normalized_event_types = [
            item.strip()
            for item in (event_types or [])
            if isinstance(item, str) and item.strip()
        ]

        if event_type and not normalized_event_types:
            clauses.append("event_type = ?")
            args.append(event_type)
        elif normalized_event_types:
            placeholders = ", ".join(["?"] * len(normalized_event_types))
            clauses.append(f"event_type IN ({placeholders})")
            args.extend(normalized_event_types)

        if cursor_created_at and cursor_event_id:
            clauses.append("(created_at > ? OR (created_at = ? AND id > ?))")
            args.extend([cursor_created_at, cursor_created_at, cursor_event_id])
        elif cursor_created_at:
            clauses.append("created_at > ?")
            args.append(cursor_created_at)

        if clauses:
            query += " WHERE " + " AND ".join(clauses)
        query += " ORDER BY created_at ASC, id ASC LIMIT ?"
        args.append(limit)

        with self._connect() as conn:
            rows = conn.execute(query, tuple(args)).fetchall()

        return [
            Event(
                event_id=row["id"],
                event_type=row["event_type"],
                source=row["source"],
                subject=row["subject"],
                payload=json.loads(row["payload"]),
                timestamp=_from_iso(row["created_at"]) or datetime.now(timezone.utc),
                idempotency_key=row["idempotency_key"],
                risk_hint=row["risk_hint"],
            )
            for row in rows
        ]

    def insert_rule_run(self, run: RuleRun) -> None:
        with self._connect() as conn:
            conn.execute(
                """
                INSERT INTO event_rule_runs (id, rule_id, event_id, decision, reason, status, action_trace_id, duration_ms, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    run.run_id,
                    run.rule_id,
                    run.event_id,
                    run.decision,
                    run.reason,
                    run.status,
                    run.action_trace_id,
                    run.duration_ms,
                    _to_iso(run.created_at),
                ),
            )

    def list_rule_runs(
        self,
        *,
        rule_id: str | None = None,
        event_id: str | None = None,
        status: str | None = None,
        limit: int = 100,
    ) -> list[RuleRun]:
        query = """
            SELECT id, rule_id, event_id, decision, reason, status, action_trace_id, duration_ms, created_at
            FROM event_rule_runs
        """
        clauses: list[str] = []
        args: list[str | int] = []
        if rule_id:
            clauses.append("rule_id = ?")
            args.append(rule_id)
        if event_id:
            clauses.append("event_id = ?")
            args.append(event_id)
        if status:
            clauses.append("status = ?")
            args.append(status)
        if clauses:
            query += " WHERE " + " AND ".join(clauses)
        query += " ORDER BY created_at DESC LIMIT ?"
        args.append(limit)

        with self._connect() as conn:
            rows = conn.execute(query, tuple(args)).fetchall()
        return [
            RuleRun(
                run_id=row["id"],
                rule_id=row["rule_id"],
                event_id=row["event_id"],
                decision=row["decision"],
                reason=row["reason"] or "",
                status=row["status"],
                action_trace_id=row["action_trace_id"],
                duration_ms=row["duration_ms"],
                created_at=_from_iso(row["created_at"]) or datetime.now(timezone.utc),
            )
            for row in rows
        ]

    def update_rule_run(
        self,
        run_id: str,
        *,
        status: str,
        reason: str | None = None,
        duration_ms: int | None = None,
        action_trace_id: str | None = None,
    ) -> None:
        with self._connect() as conn:
            conn.execute(
                """
                UPDATE event_rule_runs
                SET status = ?, reason = COALESCE(?, reason), duration_ms = COALESCE(?, duration_ms), action_trace_id = COALESCE(?, action_trace_id)
                WHERE id = ?
                """,
                (status, reason, duration_ms, action_trace_id, run_id),
            )

    def insert_approval(self, approval: ApprovalRequest) -> None:
        with self._connect() as conn:
            conn.execute(
                """
                INSERT INTO approval_requests (id, rule_id, event_id, risk_level, status, created_at, resolved_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    approval.approval_id,
                    approval.rule_id,
                    approval.event_id,
                    approval.risk_level,
                    approval.status,
                    _to_iso(approval.created_at),
                    _to_iso(approval.resolved_at),
                ),
                )

    def update_approval(self, approval_id: str, status: str) -> None:
        resolved_at = _to_iso(datetime.now(timezone.utc)) if status != "pending" else None
        with self._connect() as conn:
            conn.execute(
                """
                UPDATE approval_requests
                SET status = ?, resolved_at = ?
                WHERE id = ?
                """,
                (status, resolved_at, approval_id),
            )

    def get_approval(self, approval_id: str) -> ApprovalRequest | None:
        with self._connect() as conn:
            row = conn.execute(
                """
                SELECT id, rule_id, event_id, risk_level, status, created_at, resolved_at
                FROM approval_requests WHERE id = ?
                """,
                (approval_id,),
            ).fetchone()
            if row is None:
                return None
            return ApprovalRequest(
                approval_id=row["id"],
                rule_id=row["rule_id"],
                event_id=row["event_id"],
                risk_level=row["risk_level"],
                status=row["status"],
                created_at=_from_iso(row["created_at"]) or datetime.now(timezone.utc),
                resolved_at=_from_iso(row["resolved_at"]),
            )

    def list_pending_approvals(self) -> list[ApprovalRequest]:
        return self.list_approvals(status="pending", limit=1000)

    def list_approvals(
        self,
        *,
        status: str | None = None,
        limit: int = 100,
    ) -> list[ApprovalRequest]:
        with self._connect() as conn:
            if status:
                rows = conn.execute(
                    """
                    SELECT id, rule_id, event_id, risk_level, status, created_at, resolved_at
                    FROM approval_requests
                    WHERE status = ?
                    ORDER BY created_at ASC
                    LIMIT ?
                    """,
                    (status, limit),
                ).fetchall()
            else:
                rows = conn.execute(
                    """
                    SELECT id, rule_id, event_id, risk_level, status, created_at, resolved_at
                    FROM approval_requests
                    ORDER BY created_at DESC
                    LIMIT ?
                    """,
                    (limit,),
                ).fetchall()
            results: list[ApprovalRequest] = []
            for row in rows:
                results.append(
                    ApprovalRequest(
                        approval_id=row["id"],
                        rule_id=row["rule_id"],
                        event_id=row["event_id"],
                        risk_level=row["risk_level"],
                        status=row["status"],
                        created_at=_from_iso(row["created_at"]) or datetime.now(timezone.utc),
                        resolved_at=_from_iso(row["resolved_at"]),
                    )
                )
            return results

    def get_metrics(self, *, since: datetime | None = None) -> dict[str, object]:
        """Return aggregated Event Engine metrics from SQLite."""
        since_iso = _to_iso(since)
        with self._connect() as conn:
            events_total = self._count_with_optional_since(
                conn=conn,
                table="events",
                time_field="created_at",
                since_iso=since_iso,
            )
            rule_runs_total = self._count_with_optional_since(
                conn=conn,
                table="event_rule_runs",
                time_field="created_at",
                since_iso=since_iso,
            )
            approvals_total = self._count_with_optional_since(
                conn=conn,
                table="approval_requests",
                time_field="created_at",
                since_iso=since_iso,
            )

            if since_iso:
                row = conn.execute(
                    """
                    SELECT
                      SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
                      SUM(CASE WHEN status = 'approved' THEN 1 ELSE 0 END) AS approved,
                      SUM(CASE WHEN status = 'rejected' THEN 1 ELSE 0 END) AS rejected
                    FROM approval_requests
                    WHERE created_at >= ?
                    """,
                    (since_iso,),
                ).fetchone()
            else:
                row = conn.execute(
                    """
                    SELECT
                      SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
                      SUM(CASE WHEN status = 'approved' THEN 1 ELSE 0 END) AS approved,
                      SUM(CASE WHEN status = 'rejected' THEN 1 ELSE 0 END) AS rejected
                    FROM approval_requests
                    """
                ).fetchone()
            approvals_pending = int(row["pending"] or 0)
            approvals_approved = int(row["approved"] or 0)
            approvals_rejected = int(row["rejected"] or 0)

            if since_iso:
                rule_row = conn.execute(
                    """
                    SELECT
                      SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
                      SUM(CASE WHEN status = 'partial' THEN 1 ELSE 0 END) AS partial,
                      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
                      SUM(CASE WHEN status = 'skipped' THEN 1 ELSE 0 END) AS skipped
                    FROM event_rule_runs
                    WHERE created_at >= ?
                    """,
                    (since_iso,),
                ).fetchone()
            else:
                rule_row = conn.execute(
                    """
                    SELECT
                      SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
                      SUM(CASE WHEN status = 'partial' THEN 1 ELSE 0 END) AS partial,
                      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
                      SUM(CASE WHEN status = 'skipped' THEN 1 ELSE 0 END) AS skipped
                    FROM event_rule_runs
                    """
                ).fetchone()

            if since_iso:
                duration_row = conn.execute(
                    "SELECT AVG(duration_ms) AS avg_duration_ms FROM event_rule_runs WHERE duration_ms IS NOT NULL AND created_at >= ?",
                    (since_iso,),
                ).fetchone()
            else:
                duration_row = conn.execute(
                    "SELECT AVG(duration_ms) AS avg_duration_ms FROM event_rule_runs WHERE duration_ms IS NOT NULL"
                ).fetchone()
            avg_rule_duration_ms = float(duration_row["avg_duration_ms"] or 0.0)

            if since_iso:
                approval_duration_row = conn.execute(
                    """
                    SELECT AVG((julianday(resolved_at) - julianday(created_at)) * 86400000.0) AS avg_ms
                    FROM approval_requests
                    WHERE resolved_at IS NOT NULL AND created_at >= ?
                    """,
                    (since_iso,),
                ).fetchone()
            else:
                approval_duration_row = conn.execute(
                    """
                    SELECT AVG((julianday(resolved_at) - julianday(created_at)) * 86400000.0) AS avg_ms
                    FROM approval_requests
                    WHERE resolved_at IS NOT NULL
                    """
                ).fetchone()
            avg_approval_resolution_ms = float(approval_duration_row["avg_ms"] or 0.0)

            if since_iso:
                top_rows = conn.execute(
                    """
                    SELECT event_type, COUNT(*) AS cnt
                    FROM events
                    WHERE created_at >= ?
                    GROUP BY event_type
                    ORDER BY cnt DESC, event_type ASC
                    LIMIT 10
                    """,
                    (since_iso,),
                ).fetchall()
            else:
                top_rows = conn.execute(
                    """
                    SELECT event_type, COUNT(*) AS cnt
                    FROM events
                    GROUP BY event_type
                    ORDER BY cnt DESC, event_type ASC
                    LIMIT 10
                    """
                ).fetchall()

        return {
            "events_total": int(events_total),
            "rule_runs_total": int(rule_runs_total),
            "rule_runs_completed": int(rule_row["completed"] or 0),
            "rule_runs_partial": int(rule_row["partial"] or 0),
            "rule_runs_failed": int(rule_row["failed"] or 0),
            "rule_runs_skipped": int(rule_row["skipped"] or 0),
            "approvals_total": int(approvals_total),
            "approvals_pending": approvals_pending,
            "approvals_approved": approvals_approved,
            "approvals_rejected": approvals_rejected,
            "avg_rule_duration_ms": round(avg_rule_duration_ms, 2),
            "avg_approval_resolution_ms": round(avg_approval_resolution_ms, 2),
            "top_event_types": [
                {"event_type": str(row["event_type"]), "count": int(row["cnt"])} for row in top_rows
            ],
        }

    def _count_with_optional_since(
        self,
        *,
        conn: sqlite3.Connection,
        table: str,
        time_field: str,
        since_iso: str | None,
    ) -> int:
        if since_iso:
            row = conn.execute(
                f"SELECT COUNT(*) AS c FROM {table} WHERE {time_field} >= ?",
                (since_iso,),
            ).fetchone()
        else:
            row = conn.execute(f"SELECT COUNT(*) AS c FROM {table}").fetchone()
        return int(row["c"] if row and row["c"] is not None else 0)
