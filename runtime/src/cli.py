"""Semibot V2 CLI entrypoint.

This CLI is the first step of the V2.0 refactor and intentionally keeps
commands small while the new single-process architecture is built out.
"""

from __future__ import annotations

import argparse
import asyncio
import json
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import uvicorn

from src.bootstrap import (
    default_db_path as bootstrap_default_db_path,
)
from src.bootstrap import (
    default_rules_path as bootstrap_default_rules_path,
)
from src.bootstrap import (
    ensure_runtime_home,
)
from src.events.event_engine import EventEngine
from src.events.event_store import EventStore
from src.events.models import Event, utc_now
from src.events.rule_loader import load_rules, rules_to_json, set_rule_active
from src.local_runtime import run_task_once
from src.server.api import create_app
from src.skills.bootstrap import create_default_registry


def _print_json(payload: dict[str, Any]) -> None:
    print(json.dumps(payload, ensure_ascii=False, indent=2))


def _default_db_path() -> str:
    return str(bootstrap_default_db_path())


def _default_rules_path() -> str:
    return str(bootstrap_default_rules_path())


def _bootstrap_from_args(args: argparse.Namespace) -> None:
    db_path = getattr(args, "db_path", None)
    rules_path = getattr(args, "rules_path", None)
    ensure_runtime_home(db_path=db_path, rules_path=rules_path)


def cmd_init(args: argparse.Namespace) -> int:
    summary = ensure_runtime_home(db_path=args.db_path, rules_path=args.rules_path)
    _print_json(
        {
            "version": "2.0.0",
            "mode": "init",
            **summary,
        }
    )
    return 0


def _execute_task_from_args(
    args: argparse.Namespace,
    task: str,
    *,
    session_id: str | None = None,
) -> dict[str, Any]:
    return asyncio.run(
        run_task_once(
            task=task,
            db_path=args.db_path,
            rules_path=args.rules_path,
            agent_id=args.agent_id,
            session_id=session_id or args.session_id,
            model=args.model,
            system_prompt=args.system_prompt,
        )
    )


def cmd_chat(args: argparse.Namespace) -> int:
    resolved_session_id = args.session_id or f"chat_{int(datetime.now(UTC).timestamp() * 1000)}"

    _print_json(
        {
            "version": "2.0.0",
            "mode": "chat",
            "session_id": resolved_session_id,
            "message": "Chat session started. Type 'exit' to quit.",
        }
    )

    if args.message:
        result = _execute_task_from_args(args, args.message, session_id=resolved_session_id)
        if args.json:
            _print_json(result)
        else:
            print(result.get("final_response") or "")
        return 0 if result.get("status") == "completed" else 1

    while True:
        try:
            user_input = input("You> ").strip()
        except EOFError:
            print("")
            break
        except KeyboardInterrupt:
            print("")
            break

        if not user_input:
            continue
        if user_input.lower() in {"exit", "quit", "q"}:
            break

        result = _execute_task_from_args(args, user_input, session_id=resolved_session_id)
        if args.json:
            _print_json(result)
        else:
            print(f"Semibot> {result.get('final_response') or ''}")

    return 0


def cmd_run(args: argparse.Namespace) -> int:
    result = _execute_task_from_args(args, args.task)
    _print_json(
        {
            "version": "2.0.0",
            "mode": "run",
            "task": args.task,
            "accepted_at": datetime.now(UTC).isoformat(),
            **result,
        }
    )
    return 0 if result.get("status") == "completed" else 1


def cmd_serve(args: argparse.Namespace) -> int:
    cron_jobs: list[dict[str, Any]] | None = None
    if args.cron_jobs_json:
        try:
            parsed = json.loads(args.cron_jobs_json)
            if isinstance(parsed, list):
                cron_jobs = [
                    {str(key): value for key, value in item.items()}
                    for item in parsed
                    if isinstance(item, dict)
                ]
        except json.JSONDecodeError:
            _print_json(
                {
                    "version": "2.0.0",
                    "mode": "serve",
                    "error": "invalid --cron-jobs-json, expected JSON array",
                }
            )
            return 1

    app = create_app(
        db_path=args.db_path,
        rules_path=args.rules_path,
        heartbeat_interval_seconds=args.heartbeat_interval,
        cron_jobs=cron_jobs,
    )
    uvicorn.run(app, host=args.host, port=args.port, log_level="info")
    return 0


def cmd_skill_list(_args: argparse.Namespace) -> int:
    registry = create_default_registry()
    _print_json(
        {
            "version": "2.0.0",
            "resource": "skill",
            "action": "list",
            "tools": registry.list_tools(),
            "skills": registry.list_skills(),
        }
    )
    return 0


def cmd_events_list(args: argparse.Namespace) -> int:
    store = EventStore(db_path=args.db_path)
    events = store.list_events(limit=args.limit, event_type=args.event_type)
    _print_json(
        {
            "version": "2.0.0",
            "resource": "events",
            "action": "list",
            "count": len(events),
            "items": [
                {
                    "event_id": event.event_id,
                    "event_type": event.event_type,
                    "source": event.source,
                    "subject": event.subject,
                    "timestamp": event.timestamp.isoformat(),
                    "risk_hint": event.risk_hint,
                }
                for event in events
            ],
        }
    )
    return 0


def _build_event_engine(args: argparse.Namespace) -> EventEngine:
    return EventEngine(
        store=EventStore(db_path=args.db_path),
        rules_path=args.rules_path,
    )


def cmd_events_replay(args: argparse.Namespace) -> int:
    engine = _build_event_engine(args)
    outcomes = asyncio.run(engine.replay_event(args.event_id))
    _print_json(
        {
            "version": "2.0.0",
            "resource": "events",
            "action": "replay",
            "event_id": args.event_id,
            "matched_rules": len(outcomes),
            "outcomes": [
                {
                    "run_id": item.run_id,
                    "rule_id": item.rule_id,
                    "decision": item.decision,
                    "status": item.status,
                    "reason": item.reason,
                    "approval_id": item.approval_id,
                    "errors": item.errors,
                }
                for item in outcomes
            ],
        }
    )
    return 0


def cmd_events_emit(args: argparse.Namespace) -> int:
    engine = _build_event_engine(args)
    try:
        payload = json.loads(args.payload) if args.payload else {}
    except json.JSONDecodeError as exc:
        _print_json(
            {
                "version": "2.0.0",
                "resource": "events",
                "action": "emit",
                "error": f"invalid payload json: {exc}",
            }
        )
        return 1
    event = Event(
        event_id=args.event_id or f"evt_cli_{int(datetime.now(UTC).timestamp() * 1000)}",
        event_type=args.event_type,
        source="cli",
        subject=args.subject,
        payload=payload if isinstance(payload, dict) else {"value": payload},
        idempotency_key=args.idempotency_key,
        risk_hint=args.risk_hint,
        timestamp=utc_now(),
    )
    outcomes = asyncio.run(engine.emit(event))
    _print_json(
        {
            "version": "2.0.0",
            "resource": "events",
            "action": "emit",
            "event_id": event.event_id,
            "matched_rules": len(outcomes),
        }
    )
    return 0


def cmd_events_stats(args: argparse.Namespace) -> int:
    store = EventStore(db_path=args.db_path)
    since_dt = None
    if args.since:
        try:
            since_dt = datetime.fromisoformat(args.since.replace("Z", "+00:00"))
        except ValueError as exc:
            _print_json(
                {
                    "version": "2.0.0",
                    "resource": "events",
                    "action": "stats",
                    "error": f"invalid since: {exc}",
                }
            )
            return 1
    metrics = store.get_metrics(since=since_dt)
    _print_json(
        {
            "version": "2.0.0",
            "resource": "events",
            "action": "stats",
            "since": args.since,
            "metrics": metrics,
        }
    )
    return 0


def cmd_events_queue(args: argparse.Namespace) -> int:
    store = EventStore(db_path=args.db_path)
    rows = store.list_events(limit=1, event_type="rule.queue.telemetry")
    snapshot = rows[0].payload if rows else {}
    _print_json(
        {
            "version": "2.0.0",
            "resource": "events",
            "action": "queue",
            "snapshot": snapshot if isinstance(snapshot, dict) else {},
        }
    )
    return 0


def cmd_memory_search(args: argparse.Namespace) -> int:
    query = args.query.strip().lower()
    store = EventStore(db_path=args.db_path)
    events = store.list_events(limit=args.limit)

    def _match(event: Event) -> bool:
        haystack = " ".join(
            [
                event.event_type,
                event.subject or "",
                json.dumps(event.payload, ensure_ascii=False),
            ]
        ).lower()
        return query in haystack

    matched = [event for event in events if _match(event)]

    _print_json(
        {
            "version": "2.0.0",
            "resource": "memory",
            "action": "search",
            "query": args.query,
            "count": len(matched),
            "items": [
                {
                    "event_id": event.event_id,
                    "event_type": event.event_type,
                    "subject": event.subject,
                    "timestamp": event.timestamp.isoformat(),
                    "payload": event.payload,
                }
                for event in matched
            ],
        }
    )
    return 0


def cmd_rules_list(args: argparse.Namespace) -> int:
    rules = load_rules(args.rules_path)
    _print_json(
        {
            "version": "2.0.0",
            "resource": "rules",
            "action": "list",
            "rules_path": str(Path(args.rules_path).expanduser()),
            "count": len(rules),
            "items": rules_to_json(rules),
        }
    )
    return 0


def cmd_rules_toggle(args: argparse.Namespace) -> int:
    updated = set_rule_active(args.rules_path, args.rule_id, active=args.active)
    _print_json(
        {
            "version": "2.0.0",
            "resource": "rules",
            "action": "enable" if args.active else "disable",
            "rule_id": args.rule_id,
            "updated": updated,
            "rules_path": str(Path(args.rules_path).expanduser()),
        }
    )
    return 0 if updated else 1


def cmd_approvals_list(args: argparse.Namespace) -> int:
    store = EventStore(db_path=args.db_path)
    approvals = store.list_approvals(status=args.status, limit=args.limit)
    _print_json(
        {
            "version": "2.0.0",
            "resource": "approvals",
            "action": "list",
            "count": len(approvals),
            "items": [
                {
                    "approval_id": item.approval_id,
                    "rule_id": item.rule_id,
                    "event_id": item.event_id,
                    "risk_level": item.risk_level,
                    "status": item.status,
                    "created_at": item.created_at.isoformat(),
                    "resolved_at": item.resolved_at.isoformat() if item.resolved_at else None,
                }
                for item in approvals
            ],
        }
    )
    return 0


def cmd_approvals_resolve(args: argparse.Namespace) -> int:
    store = EventStore(db_path=args.db_path)
    engine = EventEngine(store=store, rules_path=args.rules_path)
    approval = asyncio.run(engine.resolve_approval(args.approval_id, args.decision))
    _print_json(
        {
            "version": "2.0.0",
            "resource": "approvals",
            "action": args.decision,
            "approval_id": args.approval_id,
            "found": approval is not None,
            "status": approval.status if approval else None,
        }
    )
    return 0 if approval else 1


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="semibot", description="Semibot V2 CLI")
    subparsers = parser.add_subparsers(dest="command", required=True)

    init_parser = subparsers.add_parser("init", help="Initialize local Semibot home")
    init_parser.add_argument("--db-path", default=_default_db_path(), help="SQLite DB path")
    init_parser.add_argument("--rules-path", default=_default_rules_path(), help="Rules path")
    init_parser.set_defaults(func=cmd_init)

    chat_parser = subparsers.add_parser("chat", help="Start CLI chat mode")
    chat_parser.add_argument("--db-path", default=_default_db_path(), help="SQLite DB path")
    chat_parser.add_argument("--rules-path", default=_default_rules_path(), help="Rules path")
    chat_parser.add_argument("--agent-id", default="semibot", help="Agent ID")
    chat_parser.add_argument("--session-id", default=None, help="Session ID override")
    chat_parser.add_argument("--model", default=None, help="Model override")
    chat_parser.add_argument("--system-prompt", default=None, help="Agent system prompt override")
    chat_parser.add_argument("--message", default=None, help="Run one chat turn and exit")
    chat_parser.add_argument(
        "--json",
        action="store_true",
        help="Print assistant result in JSON for each turn",
    )
    chat_parser.set_defaults(func=cmd_chat)

    run_parser = subparsers.add_parser("run", help="Run a single task")
    run_parser.add_argument("task", help="Task prompt")
    run_parser.add_argument("--db-path", default=_default_db_path(), help="SQLite DB path")
    run_parser.add_argument("--rules-path", default=_default_rules_path(), help="Rules path")
    run_parser.add_argument("--agent-id", default="semibot", help="Agent ID")
    run_parser.add_argument("--session-id", default=None, help="Session ID override")
    run_parser.add_argument("--model", default=None, help="Model override")
    run_parser.add_argument("--system-prompt", default=None, help="Agent system prompt override")
    run_parser.set_defaults(func=cmd_run)

    serve_parser = subparsers.add_parser("serve", help="Start local HTTP API server")
    serve_parser.add_argument("--host", default="127.0.0.1", help="Bind host")
    serve_parser.add_argument("--port", type=int, default=8765, help="Bind port")
    serve_parser.add_argument("--db-path", default=_default_db_path(), help="SQLite DB path")
    serve_parser.add_argument("--rules-path", default=_default_rules_path(), help="Rules path")
    serve_parser.add_argument(
        "--heartbeat-interval",
        type=float,
        default=None,
        help="Optional heartbeat interval seconds",
    )
    serve_parser.add_argument(
        "--cron-jobs-json",
        default=None,
        help="Optional cron jobs JSON array",
    )
    serve_parser.set_defaults(func=cmd_serve)

    skill_parser = subparsers.add_parser("skill", help="Skill operations")
    skill_subparsers = skill_parser.add_subparsers(dest="skill_command", required=True)
    skill_list_parser = skill_subparsers.add_parser("list", help="List available tools/skills")
    skill_list_parser.set_defaults(func=cmd_skill_list)

    memory_parser = subparsers.add_parser("memory", help="Memory operations")
    memory_subparsers = memory_parser.add_subparsers(dest="memory_command", required=True)
    memory_search_parser = memory_subparsers.add_parser("search", help="Search local memory events")
    memory_search_parser.add_argument("query", help="Search query")
    memory_search_parser.add_argument(
        "--db-path", default=_default_db_path(), help="SQLite DB path"
    )
    memory_search_parser.add_argument("--limit", type=int, default=200, help="Max events to scan")
    memory_search_parser.set_defaults(func=cmd_memory_search)

    events_parser = subparsers.add_parser("events", help="Event operations")
    events_subparsers = events_parser.add_subparsers(dest="events_command", required=True)
    events_list_parser = events_subparsers.add_parser("list", help="List events")
    events_list_parser.add_argument(
        "--db-path",
        default=_default_db_path(),
        help="SQLite DB path",
    )
    events_list_parser.add_argument("--event-type", default=None, help="Filter by event_type")
    events_list_parser.add_argument("--limit", type=int, default=20, help="Max rows")
    events_list_parser.set_defaults(func=cmd_events_list)
    events_replay_parser = events_subparsers.add_parser("replay", help="Replay one event by ID")
    events_replay_parser.add_argument("event_id", help="Event ID")
    events_replay_parser.add_argument(
        "--db-path", default=_default_db_path(), help="SQLite DB path"
    )
    events_replay_parser.add_argument(
        "--rules-path", default=_default_rules_path(), help="Rules path"
    )
    events_replay_parser.set_defaults(func=cmd_events_replay)
    events_emit_parser = events_subparsers.add_parser("emit", help="Emit one custom event")
    events_emit_parser.add_argument("event_type", help="Event type")
    events_emit_parser.add_argument("--payload", default="{}", help="JSON payload string")
    events_emit_parser.add_argument("--subject", default=None, help="Event subject")
    events_emit_parser.add_argument("--event-id", default=None, help="Event ID override")
    events_emit_parser.add_argument("--idempotency-key", default=None, help="Idempotency key")
    events_emit_parser.add_argument("--risk-hint", default=None, help="Risk hint")
    events_emit_parser.add_argument("--db-path", default=_default_db_path(), help="SQLite DB path")
    events_emit_parser.add_argument(
        "--rules-path", default=_default_rules_path(), help="Rules path"
    )
    events_emit_parser.set_defaults(func=cmd_events_emit)
    events_stats_parser = events_subparsers.add_parser("stats", help="Show event engine metrics")
    events_stats_parser.add_argument("--db-path", default=_default_db_path(), help="SQLite DB path")
    events_stats_parser.add_argument("--since", default=None, help="ISO datetime filter")
    events_stats_parser.set_defaults(func=cmd_events_stats)
    events_queue_parser = events_subparsers.add_parser("queue", help="Show latest queue telemetry")
    events_queue_parser.add_argument("--db-path", default=_default_db_path(), help="SQLite DB path")
    events_queue_parser.set_defaults(func=cmd_events_queue)

    rules_parser = subparsers.add_parser("rules", help="Rule operations")
    rules_subparsers = rules_parser.add_subparsers(dest="rules_command", required=True)
    rules_list_parser = rules_subparsers.add_parser("list", help="List rules")
    rules_list_parser.add_argument(
        "--rules-path",
        default=_default_rules_path(),
        help="Rules file (.json) or directory",
    )
    rules_list_parser.set_defaults(func=cmd_rules_list)
    rules_enable_parser = rules_subparsers.add_parser("enable", help="Enable one rule")
    rules_enable_parser.add_argument("rule_id", help="Rule ID")
    rules_enable_parser.add_argument(
        "--rules-path", default=_default_rules_path(), help="Rules path"
    )
    rules_enable_parser.set_defaults(func=cmd_rules_toggle, active=True)
    rules_disable_parser = rules_subparsers.add_parser("disable", help="Disable one rule")
    rules_disable_parser.add_argument("rule_id", help="Rule ID")
    rules_disable_parser.add_argument(
        "--rules-path", default=_default_rules_path(), help="Rules path"
    )
    rules_disable_parser.set_defaults(func=cmd_rules_toggle, active=False)

    approvals_parser = subparsers.add_parser("approvals", help="Approval operations")
    approvals_subparsers = approvals_parser.add_subparsers(dest="approvals_command", required=True)
    approvals_list_parser = approvals_subparsers.add_parser("list", help="List approvals")
    approvals_list_parser.add_argument(
        "--db-path", default=_default_db_path(), help="SQLite DB path"
    )
    approvals_list_parser.add_argument("--status", default=None, help="pending/approved/rejected")
    approvals_list_parser.add_argument("--limit", type=int, default=20, help="Max rows")
    approvals_list_parser.set_defaults(func=cmd_approvals_list)
    approvals_approve_parser = approvals_subparsers.add_parser(
        "approve", help="Approve one request"
    )
    approvals_approve_parser.add_argument("approval_id", help="Approval ID")
    approvals_approve_parser.add_argument(
        "--db-path", default=_default_db_path(), help="SQLite DB path"
    )
    approvals_approve_parser.add_argument(
        "--rules-path", default=_default_rules_path(), help="Rules path"
    )
    approvals_approve_parser.set_defaults(func=cmd_approvals_resolve, decision="approved")
    approvals_reject_parser = approvals_subparsers.add_parser("reject", help="Reject one request")
    approvals_reject_parser.add_argument("approval_id", help="Approval ID")
    approvals_reject_parser.add_argument(
        "--db-path", default=_default_db_path(), help="SQLite DB path"
    )
    approvals_reject_parser.add_argument(
        "--rules-path", default=_default_rules_path(), help="Rules path"
    )
    approvals_reject_parser.set_defaults(func=cmd_approvals_resolve, decision="rejected")

    return parser


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()
    _bootstrap_from_args(args)
    exit_code = args.func(args)
    raise SystemExit(exit_code)


if __name__ == "__main__":
    main()
