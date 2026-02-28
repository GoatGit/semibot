"""FastAPI app for Event Engine management APIs."""

from __future__ import annotations

import asyncio
import base64
import json
import os
import time
from collections.abc import Awaitable, Callable
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from uuid import uuid4

from fastapi import FastAPI, HTTPException, Query, Request
from pydantic import BaseModel, Field
from starlette.responses import StreamingResponse

from src.events.event_engine import EventEngine
from src.events.event_router import EventRouter
from src.events.event_store import EventStore
from src.events.models import Event
from src.events.rule_loader import load_rules, rules_to_json, set_rule_active
from src.events.runtime_action_executor import RuntimeActionExecutor
from src.gateway.context_service import GatewayContextService
from src.gateway.manager import GatewayManager
from src.gateway.notifiers.feishu_notifier import SendFn
from src.gateway.notifiers.telegram_notifier import SendFn as TelegramSendFn
from src.gateway.parsers.approval_text import extract_message_text
from src.runtime_service import run_task_once
from src.server.config_store import RuntimeConfigStore
from src.server.routes.gateway import register_gateway_routes
from src.skills.bootstrap import create_default_registry

TaskRunner = Callable[..., Awaitable[dict[str, Any]]]


class EmitEventRequest(BaseModel):
    event_type: str
    source: str = "api"
    subject: str | None = None
    payload: dict[str, Any] = Field(default_factory=dict)
    idempotency_key: str | None = None
    risk_hint: str | None = None


class ReplayEventRequest(BaseModel):
    event_id: str


class HeartbeatRequest(BaseModel):
    source: str = "system.api"
    subject: str | None = "system"
    payload: dict[str, Any] = Field(default_factory=dict)


class RunTaskRequest(BaseModel):
    task: str
    agent_id: str = "semibot"
    session_id: str | None = None
    model: str | None = None
    system_prompt: str | None = None


class ChatStartRequest(BaseModel):
    message: str
    agent_id: str = "semibot"
    session_id: str | None = None
    model: str | None = None
    system_prompt: str | None = None
    stream: bool = False


class ChatSessionRequest(BaseModel):
    message: str
    agent_id: str = "semibot"
    model: str | None = None
    system_prompt: str | None = None
    stream: bool = False


def create_app(
    *,
    db_path: str | None = None,
    rules_path: str | None = None,
    heartbeat_interval_seconds: float | None = None,
    cron_jobs: list[dict[str, Any]] | None = None,
    feishu_verify_token: str | None = None,
    feishu_webhook_url: str | None = None,
    feishu_webhook_urls: dict[str, str] | None = None,
    feishu_notify_event_types: set[str] | None = None,
    feishu_templates: dict[str, dict[str, str]] | None = None,
    feishu_send_fn: SendFn | None = None,
    telegram_bot_token: str | None = None,
    telegram_default_chat_id: str | None = None,
    telegram_webhook_secret: str | None = None,
    telegram_notify_event_types: set[str] | None = None,
    telegram_send_fn: TelegramSendFn | None = None,
    task_runner: TaskRunner | None = None,
) -> FastAPI:
    db = db_path or str(Path("~/.semibot/semibot.db").expanduser())
    rules = rules_path or str(Path("~/.semibot/rules").expanduser())
    _task_runner = task_runner or run_task_once
    # Expose runtime db path for tool-level config readers (e.g. SearchTool).
    os.environ["SEMIBOT_EVENTS_DB_PATH"] = db
    config_store = RuntimeConfigStore(db_path=db)
    gateway_context = GatewayContextService(
        db_path=db,
        config_store=config_store,
        task_runner=_task_runner,
        runtime_db_path=db,
        rules_path=rules,
    )

    def _to_bool(value: Any, default: bool = False) -> bool:
        if isinstance(value, bool):
            return value
        if value is None:
            return default
        if isinstance(value, str):
            normalized = value.strip().lower()
            if normalized in {"1", "true", "yes", "on"}:
                return True
            if normalized in {"0", "false", "no", "off"}:
                return False
        return bool(value)

    gateway_manager: GatewayManager | None = None

    async def _runtime_event_sink(runtime_event: dict[str, Any]) -> None:
        event_name = str(runtime_event.get("event") or "")
        data = runtime_event.get("data")
        payload = data if isinstance(data, dict) else {}
        if event_name == "rule.notify" and gateway_manager:
            await gateway_manager.handle_runtime_notify_payload(payload)

    action_executor = RuntimeActionExecutor(runtime_event_sink=_runtime_event_sink)
    engine = EventEngine(
        store=EventStore(db_path=db),
        router=EventRouter(action_executor),
        rules_path=rules,
    )

    gateway_manager = GatewayManager(
        config_store=config_store,
        gateway_context=gateway_context,
        engine=engine,
        feishu_verify_token=feishu_verify_token,
        feishu_webhook_url=feishu_webhook_url,
        feishu_webhook_urls=feishu_webhook_urls,
        feishu_notify_event_types=feishu_notify_event_types,
        feishu_templates=feishu_templates,
        feishu_send_fn=feishu_send_fn,
        telegram_bot_token=telegram_bot_token,
        telegram_default_chat_id=telegram_default_chat_id,
        telegram_webhook_secret=telegram_webhook_secret,
        telegram_notify_event_types=telegram_notify_event_types,
        telegram_send_fn=telegram_send_fn,
    )

    async def _gateway_event_sink(event: Event) -> None:
        if gateway_manager:
            await gateway_manager.handle_engine_event(event)

    engine.bus.subscribe(_gateway_event_sink)

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        engine.start_rule_watch(poll_interval=1.0)
        if heartbeat_interval_seconds and heartbeat_interval_seconds > 0:
            engine.start_heartbeat(interval_seconds=heartbeat_interval_seconds)
        if cron_jobs:
            normalized_jobs = [
                {str(key): value for key, value in item.items()}
                for item in cron_jobs
                if isinstance(item, dict)
            ]
            if normalized_jobs:
                engine.start_cron_jobs(normalized_jobs)
        try:
            yield
        finally:
            await engine.stop_triggers()
            await engine.stop_rule_watch()

    app = FastAPI(title="Semibot Event API", version="2.0.0", lifespan=lifespan)

    def _latest_queue_state() -> dict[str, Any]:
        queue_events = engine.list_events(limit=1, event_type="rule.queue.telemetry")
        if not queue_events:
            return {
                "queued_depth": 0,
                "active_jobs": 0,
                "accepted_jobs": 0,
                "dropped_jobs": 0,
                "completed_jobs": 0,
                "failed_jobs": 0,
                "running_workers": 0,
                "configured_workers": 0,
                "queue_maxsize": 0,
            }
        payload = queue_events[0].payload
        return payload if isinstance(payload, dict) else {}

    def _serialize_approval(item: Any) -> dict[str, Any]:
        context = item.context if isinstance(getattr(item, "context", None), dict) else {}
        return {
            "approval_id": item.approval_id,
            "rule_id": item.rule_id,
            "event_id": item.event_id,
            "risk_level": item.risk_level,
            "status": item.status,
            "created_at": item.created_at.isoformat(),
            "resolved_at": item.resolved_at.isoformat() if item.resolved_at else None,
            "context": context,
            "tool_name": context.get("tool_name"),
            "action": context.get("action"),
            "target": context.get("target"),
            "summary": context.get("summary"),
        }

    def _encode_cursor(created_at: str, event_id: str) -> str:
        raw = f"{created_at}|{event_id}".encode()
        return base64.urlsafe_b64encode(raw).decode("ascii")

    def _decode_cursor(cursor: str | None) -> tuple[str | None, str | None]:
        if not cursor:
            return None, None
        try:
            raw = base64.urlsafe_b64decode(cursor.encode("ascii")).decode("utf-8")
            created_at, event_id = raw.split("|", 1)
            return created_at, event_id
        except Exception:
            return None, None

    def _event_to_item(event: Event) -> dict[str, Any]:
        return {
            "event_id": event.event_id,
            "event_type": event.event_type,
            "source": event.source,
            "subject": event.subject,
            "payload": event.payload,
            "risk_hint": event.risk_hint,
            "timestamp": event.timestamp.isoformat(),
        }

    def _event_items_with_cursor(
        *,
        cursor: str | None,
        event_type: str | None,
        event_types: list[str] | None,
        limit: int,
    ) -> tuple[list[dict[str, Any]], str | None]:
        cursor_created_at, cursor_event_id = _decode_cursor(cursor)
        events = engine.list_events_after(
            cursor_created_at=cursor_created_at,
            cursor_event_id=cursor_event_id,
            event_type=event_type,
            event_types=event_types,
            limit=limit,
        )
        items = [_event_to_item(event) for event in events]
        if not events:
            return items, cursor
        last = events[-1]
        return items, _encode_cursor(last.timestamp.isoformat(), last.event_id)

    def _parse_csv(value: str | None) -> list[str]:
        if not value:
            return []
        return [item.strip() for item in value.split(",") if item.strip()]

    def _resolve_event_filters(
        event_type: str | None, event_types: str | None
    ) -> tuple[str | None, list[str] | None]:
        parsed = _parse_csv(event_types)
        if parsed:
            return None, parsed
        return event_type, None

    def _resolve_cursor(cursor: str | None, resume_from: str | None) -> str | None:
        return resume_from or cursor

    def _normalize_channels(channels: str | None) -> set[str]:
        allowed = {"summary", "queue", "events", "top_event_types"}
        requested = set(_parse_csv(channels)) if channels else set()
        if not requested:
            return allowed
        normalized = {item for item in requested if item in allowed}
        return normalized or allowed

    def _collect_runtime_index(limit: int = 1000) -> tuple[dict[str, str], set[str]]:
        sessions: dict[str, str] = {}
        agents: set[str] = set()
        for event in engine.list_events(limit=limit):
            payload = event.payload if isinstance(event.payload, dict) else {}
            session_id = payload.get("session_id")
            agent_id = payload.get("agent_id")

            if isinstance(session_id, str) and session_id and session_id not in sessions:
                sessions[session_id] = event.timestamp.isoformat()

            if isinstance(agent_id, str) and agent_id:
                agents.add(agent_id)

        if not agents:
            agents.add("semibot")
        return sessions, agents

    register_gateway_routes(app, gateway_manager)

    @app.get("/healthz")
    async def healthz() -> dict[str, Any]:
        return {"ok": True, "version": "2.0.0"}

    @app.get("/health")
    async def health() -> dict[str, Any]:
        return {"ok": True, "version": "2.0.0"}

    @app.get("/v1/skills")
    async def list_skills() -> dict[str, Any]:
        registry = create_default_registry()
        tool_names = registry.list_tools()
        skill_names = registry.list_skills()
        # Conceptual split for V2 UI/ops:
        # xlsx/pdf are exposed as "skills", not configurable builtin tools.
        skill_like_tools = {"xlsx", "pdf"}
        tools = [name for name in tool_names if name not in skill_like_tools]
        skills = sorted(set(skill_names + [name for name in tool_names if name in skill_like_tools]))
        return {
            "tools": tools,
            "skills": skills,
        }

    @app.get("/v1/config/tools")
    async def list_config_tools(
        page: int = Query(default=1, ge=1),
        limit: int = Query(default=100, ge=1, le=500),
        search: str | None = Query(default=None),
        tool_type: str | None = Query(default=None, alias="type"),
        include_builtin: str | None = Query(default=None),
        include_builtin_camel: str | None = Query(default=None, alias="includeBuiltin"),
    ) -> dict[str, Any]:
        include_value = include_builtin if include_builtin is not None else include_builtin_camel
        result = config_store.list_tools(
            include_builtin=_to_bool(include_value, True),
            page=page,
            limit=limit,
            search=search,
            tool_type=tool_type,
        )
        return result

    @app.post("/v1/config/tools")
    async def create_config_tool(request: Request) -> dict[str, Any]:
        payload = await request.json()
        item = config_store.create_tool(
            {
                "name": str(payload.get("name") or "").strip(),
                "description": payload.get("description"),
                "type": payload.get("type") or "builtin",
                "schema": payload.get("schema") or {},
                "config": payload.get("config") or {},
                "is_builtin": _to_bool(payload.get("is_builtin", payload.get("isBuiltin")), True),
                "is_active": _to_bool(payload.get("is_active", payload.get("isActive")), True),
                "org_id": payload.get("org_id", payload.get("orgId")),
                "created_by": payload.get("created_by", payload.get("createdBy")),
            }
        )
        return item

    @app.get("/v1/config/tools/by-name/{tool_name}")
    async def get_config_tool_by_name(tool_name: str) -> dict[str, Any]:
        item = config_store.get_tool_by_name(tool_name)
        if not item:
            raise HTTPException(status_code=404, detail="tool_not_found")
        return item

    @app.put("/v1/config/tools/by-name/{tool_name}")
    async def upsert_config_tool_by_name(tool_name: str, request: Request) -> dict[str, Any]:
        payload = await request.json()
        item = config_store.upsert_tool_by_name(
            tool_name,
            {
                "description": payload.get("description"),
                "type": payload.get("type"),
                "schema": payload.get("schema"),
                "config": payload.get("config"),
                "is_builtin": _to_bool(payload.get("is_builtin", payload.get("isBuiltin")), True),
                "is_active": _to_bool(payload.get("is_active", payload.get("isActive")), True),
                "org_id": payload.get("org_id", payload.get("orgId")),
                "created_by": payload.get("created_by", payload.get("createdBy")),
            },
        )
        return item

    @app.get("/v1/config/tools/{tool_id}")
    async def get_config_tool(tool_id: str) -> dict[str, Any]:
        item = config_store.get_tool_by_id(tool_id)
        if not item:
            raise HTTPException(status_code=404, detail="tool_not_found")
        return item

    @app.put("/v1/config/tools/{tool_id}")
    async def update_config_tool(tool_id: str, request: Request) -> dict[str, Any]:
        payload = await request.json()
        patch: dict[str, Any] = {}
        if "description" in payload:
            patch["description"] = payload.get("description")
        if "type" in payload:
            patch["type"] = payload.get("type")
        if "schema" in payload:
            patch["schema"] = payload.get("schema")
        if "config" in payload and isinstance(payload.get("config"), dict):
            patch["config"] = payload.get("config")
        if "is_active" in payload or "isActive" in payload:
            patch["is_active"] = _to_bool(payload.get("is_active", payload.get("isActive")))
        item = config_store.update_tool(tool_id, patch)
        if not item:
            raise HTTPException(status_code=404, detail="tool_not_found")
        return item

    @app.delete("/v1/config/tools/{tool_id}")
    async def delete_config_tool(tool_id: str) -> dict[str, Any]:
        deleted = config_store.soft_delete_tool(tool_id)
        if not deleted:
            raise HTTPException(status_code=404, detail="tool_not_found")
        return {"deleted": True}

    @app.get("/v1/config/mcp/system")
    async def list_system_mcp_servers() -> dict[str, Any]:
        return {"data": config_store.find_system_mcp_servers()}

    @app.get("/v1/config/mcp/active")
    async def list_active_mcp_servers() -> dict[str, Any]:
        return {"data": config_store.find_active_mcp_servers()}

    @app.get("/v1/config/mcp/agent/{agent_id}")
    async def list_agent_mcp_servers(agent_id: str) -> dict[str, Any]:
        return {"data": config_store.find_mcp_servers_by_agent(agent_id)}

    @app.put("/v1/config/mcp/agent/{agent_id}")
    async def set_agent_mcp_servers(agent_id: str, request: Request) -> dict[str, Any]:
        payload = await request.json()
        ids = payload.get("mcp_server_ids", payload.get("mcpServerIds")) or []
        if not isinstance(ids, list):
            raise HTTPException(status_code=400, detail="invalid_mcp_server_ids")
        config_store.set_agent_mcp_servers(agent_id, [str(item) for item in ids])
        return {"updated": True, "agent_id": agent_id, "mcp_server_ids": ids}

    @app.get("/v1/config/mcp/agent/{agent_id}/ids")
    async def list_agent_mcp_server_ids(agent_id: str) -> dict[str, Any]:
        return {"data": config_store.get_agent_mcp_server_ids(agent_id)}

    @app.get("/v1/config/mcp")
    async def list_config_mcp_servers(
        page: int = Query(default=1, ge=1),
        limit: int = Query(default=20, ge=1, le=500),
        search: str | None = Query(default=None),
        status: str | None = Query(default=None),
    ) -> dict[str, Any]:
        return config_store.list_mcp_servers(page=page, limit=limit, search=search, status=status, only_active=True)

    @app.post("/v1/config/mcp")
    async def create_config_mcp_server(request: Request) -> dict[str, Any]:
        payload = await request.json()
        name = str(payload.get("name") or "").strip()
        endpoint = str(payload.get("endpoint") or "").strip()
        if not name or not endpoint:
            raise HTTPException(status_code=400, detail="name_and_endpoint_required")
        item = config_store.create_mcp_server(
            {
                "org_id": payload.get("org_id", payload.get("orgId")),
                "name": name,
                "description": payload.get("description"),
                "endpoint": endpoint,
                "transport": payload.get("transport") or "streamable_http",
                "auth_type": payload.get("auth_type", payload.get("authType")),
                "auth_config": payload.get("auth_config", payload.get("authConfig")),
                "tools": payload.get("tools") or [],
                "resources": payload.get("resources") or [],
                "status": payload.get("status") or "disconnected",
                "last_connected_at": payload.get("last_connected_at", payload.get("lastConnectedAt")),
                "is_active": _to_bool(payload.get("is_active", payload.get("isActive")), True),
                "is_system": _to_bool(payload.get("is_system", payload.get("isSystem")), False),
                "created_by": payload.get("created_by", payload.get("createdBy")),
            }
        )
        return item

    @app.get("/v1/config/mcp/{server_id}")
    async def get_config_mcp_server(server_id: str) -> dict[str, Any]:
        item = config_store.get_mcp_server(server_id)
        if not item:
            raise HTTPException(status_code=404, detail="mcp_server_not_found")
        return item

    @app.put("/v1/config/mcp/{server_id}")
    async def update_config_mcp_server(server_id: str, request: Request) -> dict[str, Any]:
        payload = await request.json()
        patch: dict[str, Any] = {}
        for key in (
            "name",
            "description",
            "endpoint",
            "transport",
            "tools",
            "resources",
            "status",
            "auth_type",
            "auth_config",
            "last_connected_at",
        ):
            if key in payload:
                patch[key] = payload.get(key)

        if "authType" in payload:
            patch["auth_type"] = payload.get("authType")
        if "authConfig" in payload:
            patch["auth_config"] = payload.get("authConfig")
        if "lastConnectedAt" in payload:
            patch["last_connected_at"] = payload.get("lastConnectedAt")
        if "is_active" in payload or "isActive" in payload:
            patch["is_active"] = _to_bool(payload.get("is_active", payload.get("isActive")), True)
        if "is_system" in payload or "isSystem" in payload:
            patch["is_system"] = _to_bool(payload.get("is_system", payload.get("isSystem")), False)

        item = config_store.update_mcp_server(server_id, patch)
        if not item:
            raise HTTPException(status_code=404, detail="mcp_server_not_found")
        return item

    @app.delete("/v1/config/mcp/{server_id}")
    async def delete_config_mcp_server(server_id: str) -> dict[str, Any]:
        deleted = config_store.soft_delete_mcp_server(server_id)
        if not deleted:
            raise HTTPException(status_code=404, detail="mcp_server_not_found")
        return {"deleted": True}

    @app.get("/v1/sessions")
    async def list_sessions(limit: int = Query(default=100, ge=1, le=1000)) -> dict[str, Any]:
        sessions, _ = _collect_runtime_index(limit=limit * 10)
        items = [
            {"session_id": session_id, "last_seen_at": last_seen_at}
            for session_id, last_seen_at in list(sessions.items())[:limit]
        ]
        return {"items": items}

    @app.delete("/v1/sessions/{session_id}")
    async def delete_session(session_id: str) -> dict[str, Any]:
        event = Event(
            event_id=f"evt_session_delete_{uuid4().hex}",
            event_type="session.deleted",
            source="api",
            subject=session_id,
            payload={"session_id": session_id},
            risk_hint="low",
            timestamp=datetime.now(UTC),
        )
        await engine.emit(event)
        return {"deleted": True, "session_id": session_id}

    @app.get("/v1/agents")
    async def list_agents(limit: int = Query(default=100, ge=1, le=1000)) -> dict[str, Any]:
        _, agents = _collect_runtime_index(limit=limit * 10)
        return {"items": [{"agent_id": agent_id} for agent_id in sorted(agents)[:limit]]}

    @app.get("/v1/memories/search")
    async def memories_search(
        query: str = Query(..., min_length=1),
        limit: int = Query(default=50, ge=1, le=500),
    ) -> dict[str, Any]:
        keyword = query.strip().lower()
        scanned = engine.list_events(limit=max(limit * 5, limit))
        matched: list[dict[str, Any]] = []
        for event in scanned:
            haystack = " ".join(
                [
                    event.event_type,
                    event.subject or "",
                    json.dumps(event.payload, ensure_ascii=False),
                ]
            ).lower()
            if keyword in haystack:
                matched.append(
                    {
                        "event_id": event.event_id,
                        "event_type": event.event_type,
                        "subject": event.subject,
                        "payload": event.payload,
                        "timestamp": event.timestamp.isoformat(),
                    }
                )
            if len(matched) >= limit:
                break

        return {
            "query": query,
            "items": matched,
        }

    @app.post("/v1/skills/install")
    async def install_skill(payload: dict[str, Any]) -> dict[str, Any]:
        source = payload.get("source")
        return {
            "accepted": False,
            "source": source,
            "reason": "skill install API placeholder; use local skill manager in current phase",
        }

    @app.get("/v1/events")
    async def list_events(
        event_type: str | None = Query(default=None),
        event_types: str | None = Query(default=None, description="Comma-separated event types"),
        limit: int = Query(default=50, ge=1, le=500),
    ) -> dict[str, Any]:
        resolved_event_type, resolved_event_types = _resolve_event_filters(event_type, event_types)
        events = engine.list_events(
            limit=limit,
            event_type=resolved_event_type,
            event_types=resolved_event_types,
        )
        return {"items": [_event_to_item(event) for event in events]}

    @app.get("/v1/events/{event_id}")
    async def get_event(event_id: str) -> dict[str, Any]:
        event = engine.store.get(event_id)
        if not event:
            raise HTTPException(status_code=404, detail="event_not_found")
        return {
            "event_id": event.event_id,
            "event_type": event.event_type,
            "source": event.source,
            "subject": event.subject,
            "payload": event.payload,
            "risk_hint": event.risk_hint,
            "timestamp": event.timestamp.isoformat(),
        }

    @app.post("/v1/events")
    async def emit_event(req: EmitEventRequest) -> dict[str, Any]:
        event = Event(
            event_id=f"evt_api_{uuid4().hex}",
            event_type=req.event_type,
            source=req.source,
            subject=req.subject,
            payload=req.payload,
            idempotency_key=req.idempotency_key,
            risk_hint=req.risk_hint,
            timestamp=datetime.now(UTC),
        )
        outcomes = await engine.emit(event)
        return {"event_id": event.event_id, "matched_rules": len(outcomes)}

    @app.post("/v1/tasks/run")
    async def run_task(req: RunTaskRequest) -> dict[str, Any]:
        result = await _task_runner(
            task=req.task,
            db_path=db,
            rules_path=rules,
            agent_id=req.agent_id,
            session_id=req.session_id,
            model=req.model,
            system_prompt=req.system_prompt,
        )
        return {"task": req.task, **result}

    async def _chat_response(
        *,
        message: str,
        agent_id: str,
        session_id: str | None,
        model: str | None,
        system_prompt: str | None,
        stream: bool,
    ):
        if not stream:
            result = await _task_runner(
                task=message,
                db_path=db,
                rules_path=rules,
                agent_id=agent_id,
                session_id=session_id,
                model=model,
                system_prompt=system_prompt,
            )
            return {
                "message": message,
                **result,
            }

        async def _stream():
            start = {
                "event": "start",
                "session_id": session_id,
                "agent_id": agent_id,
            }
            yield f"data: {json.dumps(start, ensure_ascii=False)}\n\n"
            result = await _task_runner(
                task=message,
                db_path=db,
                rules_path=rules,
                agent_id=agent_id,
                session_id=session_id,
                model=model,
                system_prompt=system_prompt,
            )
            for event in result.get("runtime_events", []):
                yield f"data: {json.dumps(event, ensure_ascii=False)}\n\n"
            final_payload = {
                "event": "done",
                "status": result.get("status"),
                "final_response": result.get("final_response"),
                "error": result.get("error"),
                "session_id": result.get("session_id"),
                "agent_id": result.get("agent_id"),
            }
            yield f"data: {json.dumps(final_payload, ensure_ascii=False)}\n\n"

        return StreamingResponse(_stream(), media_type="text/event-stream")

    @app.post("/api/v1/chat/start")
    async def chat_start(req: ChatStartRequest):
        return await _chat_response(
            message=req.message,
            agent_id=req.agent_id,
            session_id=req.session_id,
            model=req.model,
            system_prompt=req.system_prompt,
            stream=req.stream,
        )

    @app.post("/api/v1/chat/sessions/{session_id}")
    async def chat_in_session(session_id: str, req: ChatSessionRequest):
        return await _chat_response(
            message=req.message,
            agent_id=req.agent_id,
            session_id=session_id,
            model=req.model,
            system_prompt=req.system_prompt,
            stream=req.stream,
        )

    @app.post("/v1/webhooks/{event_type}")
    async def ingest_webhook(event_type: str, request: Request) -> dict[str, Any]:
        try:
            body = await request.json()
        except Exception:
            body = {}
        if not isinstance(body, dict):
            body = {}
        payload = body.get("payload")
        event_payload = payload if isinstance(payload, dict) else body
        event = Event(
            event_id=str(body.get("event_id") or f"evt_webhook_{uuid4().hex}"),
            event_type=event_type,
            source=str(body.get("source") or "webhook"),
            subject=body.get("subject"),
            payload=event_payload if isinstance(event_payload, dict) else {},
            idempotency_key=body.get("idempotency_key"),
            risk_hint=body.get("risk_hint"),
            timestamp=datetime.now(UTC),
        )
        outcomes = await engine.emit(event)
        approval_command = None
        if event_type == "chat.message.received":
            text = extract_message_text(event.payload if isinstance(event.payload, dict) else {})
            if text:
                approval_command = await gateway_manager.handle_text_approval_command(
                    text=text,
                    source=str(event.source or "webhook"),
                    subject=str(event.subject) if isinstance(event.subject, str) else None,
                    trace_payload=event.payload if isinstance(event.payload, dict) else {},
                )
        return {
            "event_id": event.event_id,
            "event_type": event.event_type,
            "matched_rules": len(outcomes),
            "approval_command": approval_command,
        }

    @app.post("/v1/system/heartbeat")
    async def emit_heartbeat(req: HeartbeatRequest) -> dict[str, Any]:
        event = Event(
            event_id=f"evt_heartbeat_{uuid4().hex}",
            event_type="health.heartbeat.manual",
            source=req.source,
            subject=req.subject,
            payload=req.payload,
            risk_hint="low",
            timestamp=datetime.now(UTC),
        )
        outcomes = await engine.emit(event)
        return {"event_id": event.event_id, "matched_rules": len(outcomes)}

    @app.post("/v1/events/replay")
    async def replay_event(req: ReplayEventRequest) -> dict[str, Any]:
        outcomes = await engine.replay_event(req.event_id)
        return {
            "event_id": req.event_id,
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

    @app.get("/v1/rules")
    async def list_rules() -> dict[str, Any]:
        loaded = load_rules(rules)
        return {"items": rules_to_json(loaded)}

    @app.post("/v1/rules/{rule_id}/enable")
    async def enable_rule(rule_id: str) -> dict[str, Any]:
        updated = set_rule_active(rules, rule_id, active=True)
        if not updated:
            raise HTTPException(status_code=404, detail="rule_not_found")
        return {"rule_id": rule_id, "is_active": True}

    @app.post("/v1/rules/{rule_id}/disable")
    async def disable_rule(rule_id: str) -> dict[str, Any]:
        updated = set_rule_active(rules, rule_id, active=False)
        if not updated:
            raise HTTPException(status_code=404, detail="rule_not_found")
        return {"rule_id": rule_id, "is_active": False}

    @app.get("/v1/approvals")
    async def list_approvals(
        status: str | None = Query(default=None),
        limit: int = Query(default=50, ge=1, le=500),
    ) -> dict[str, Any]:
        items = engine.list_approvals(status=status, limit=limit)
        return {"items": [_serialize_approval(item) for item in items]}

    @app.get("/v1/metrics/events")
    async def event_metrics(since: str | None = Query(default=None)) -> dict[str, Any]:
        since_dt: datetime | None = None
        if since:
            try:
                normalized = since.replace("Z", "+00:00")
                since_dt = datetime.fromisoformat(normalized)
            except ValueError as exc:
                raise HTTPException(status_code=400, detail=f"invalid since: {exc}") from exc
        return engine.metrics(since=since_dt)

    @app.get("/v1/dashboard/summary")
    async def dashboard_summary() -> dict[str, Any]:
        metrics = engine.metrics()
        return {
            "events_total": metrics["events_total"],
            "rule_runs_total": metrics["rule_runs_total"],
            "rule_runs_failed": metrics["rule_runs_failed"],
            "approvals_pending": metrics["approvals_pending"],
            "approvals_total": metrics["approvals_total"],
            "top_event_types": metrics["top_event_types"],
            "queue_state": _latest_queue_state(),
        }

    @app.get("/v1/dashboard/rule-runs")
    async def dashboard_rule_runs(
        rule_id: str | None = Query(default=None),
        event_id: str | None = Query(default=None),
        status: str | None = Query(default=None),
        limit: int = Query(default=50, ge=1, le=500),
    ) -> dict[str, Any]:
        runs = engine.list_rule_runs(rule_id=rule_id, event_id=event_id, status=status, limit=limit)
        return {
            "items": [
                {
                    "run_id": run.run_id,
                    "rule_id": run.rule_id,
                    "event_id": run.event_id,
                    "decision": run.decision,
                    "reason": run.reason,
                    "status": run.status,
                    "action_trace_id": run.action_trace_id,
                    "duration_ms": run.duration_ms,
                    "created_at": run.created_at.isoformat(),
                }
                for run in runs
            ]
        }

    @app.get("/v1/dashboard/queue")
    async def dashboard_queue() -> dict[str, Any]:
        return _latest_queue_state()

    @app.get("/v1/dashboard/events")
    async def dashboard_events(
        cursor: str | None = Query(default=None),
        resume_from: str | None = Query(default=None),
        event_type: str | None = Query(default=None),
        event_types: str | None = Query(default=None, description="Comma-separated event types"),
        limit: int = Query(default=100, ge=1, le=500),
    ) -> dict[str, Any]:
        resolved_event_type, resolved_event_types = _resolve_event_filters(event_type, event_types)
        effective_cursor = _resolve_cursor(cursor, resume_from)
        items, next_cursor = _event_items_with_cursor(
            cursor=effective_cursor,
            event_type=resolved_event_type,
            event_types=resolved_event_types,
            limit=limit,
        )
        return {"items": items, "next_cursor": next_cursor}

    @app.get("/v1/dashboard/live")
    async def dashboard_live(
        interval: float = Query(default=1.0, ge=0.1, le=10.0),
        max_ticks: int | None = Query(default=None, ge=1, le=3600),
        channels: str | None = Query(
            default=None, description="summary,queue,events,top_event_types"
        ),
        mode: str = Query(default="snapshot_delta", pattern="^(snapshot_delta|delta)$"),
        delta_only: bool = Query(default=False),
        heartbeat_interval: float = Query(default=5.0, ge=0.5, le=60.0),
        cursor: str | None = Query(default=None),
        resume_from: str | None = Query(default=None),
        event_type: str | None = Query(default=None),
        event_types: str | None = Query(default=None, description="Comma-separated event types"),
        event_limit: int = Query(default=100, ge=1, le=500),
    ) -> StreamingResponse:
        selected_channels = _normalize_channels(channels)
        resolved_event_type, resolved_event_types = _resolve_event_filters(event_type, event_types)
        effective_cursor = _resolve_cursor(cursor, resume_from)

        async def event_generator():
            ticks = 0
            current_cursor = effective_cursor
            previous_summary: dict[str, Any] | None = None
            previous_queue: dict[str, Any] | None = None
            previous_top: list[dict[str, Any]] | None = None
            last_emit_monotonic = time.monotonic()

            if mode == "snapshot_delta":
                snapshot_metrics = engine.metrics()
                snapshot_payload: dict[str, Any] = {
                    "ts": datetime.now(UTC).isoformat(),
                    "stream_mode": "snapshot",
                }

                if "summary" in selected_channels:
                    snapshot_payload["summary"] = {
                        "events_total": snapshot_metrics["events_total"],
                        "rule_runs_total": snapshot_metrics["rule_runs_total"],
                        "rule_runs_failed": snapshot_metrics["rule_runs_failed"],
                        "approvals_pending": snapshot_metrics["approvals_pending"],
                    }
                    previous_summary = snapshot_payload["summary"]

                if "queue" in selected_channels:
                    snapshot_payload["queue_state"] = _latest_queue_state()
                    previous_queue = snapshot_payload["queue_state"]

                if "top_event_types" in selected_channels:
                    snapshot_payload["top_event_types"] = snapshot_metrics["top_event_types"]
                    previous_top = snapshot_payload["top_event_types"]

                if "events" in selected_channels:
                    snapshot_events = engine.list_events(
                        limit=event_limit,
                        event_type=resolved_event_type,
                        event_types=resolved_event_types,
                    )
                    snapshot_payload["events"] = [
                        _event_to_item(event) for event in snapshot_events
                    ]
                    if snapshot_events:
                        newest = snapshot_events[0]
                        current_cursor = _encode_cursor(
                            newest.timestamp.isoformat(), newest.event_id
                        )
                    snapshot_payload["next_cursor"] = current_cursor

                yield f"data: {json.dumps(snapshot_payload, ensure_ascii=False)}\n\n"
                ticks += 1
                last_emit_monotonic = time.monotonic()
                if max_ticks is not None and ticks >= max_ticks:
                    return

            while True:
                metrics = engine.metrics()
                payload: dict[str, Any] = {
                    "ts": datetime.now(UTC).isoformat(),
                    "stream_mode": "delta",
                }
                emitted = False

                if "summary" in selected_channels:
                    current_summary = {
                        "events_total": metrics["events_total"],
                        "rule_runs_total": metrics["rule_runs_total"],
                        "rule_runs_failed": metrics["rule_runs_failed"],
                        "approvals_pending": metrics["approvals_pending"],
                    }
                    if (not delta_only) or (previous_summary != current_summary):
                        payload["summary"] = current_summary
                        emitted = True
                    previous_summary = current_summary

                if "queue" in selected_channels:
                    current_queue = _latest_queue_state()
                    if (not delta_only) or (previous_queue != current_queue):
                        payload["queue_state"] = current_queue
                        emitted = True
                    previous_queue = current_queue

                if "top_event_types" in selected_channels:
                    current_top = metrics["top_event_types"]
                    if (not delta_only) or (previous_top != current_top):
                        payload["top_event_types"] = current_top
                        emitted = True
                    previous_top = current_top

                if "events" in selected_channels:
                    events, next_cursor = _event_items_with_cursor(
                        cursor=current_cursor,
                        event_type=resolved_event_type,
                        event_types=resolved_event_types,
                        limit=event_limit,
                    )
                    current_cursor = next_cursor
                    if (not delta_only) or events:
                        payload["events"] = events
                        payload["next_cursor"] = current_cursor
                        emitted = True

                if emitted:
                    yield f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"
                    ticks += 1
                    last_emit_monotonic = time.monotonic()
                    if max_ticks is not None and ticks >= max_ticks:
                        break
                elif time.monotonic() - last_emit_monotonic >= heartbeat_interval:
                    yield ": ping\n\n"
                    last_emit_monotonic = time.monotonic()

                await asyncio.sleep(interval)

        return StreamingResponse(
            event_generator(),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "Connection": "keep-alive"},
        )

    @app.post("/v1/approvals/{approval_id}/approve")
    async def approve(approval_id: str) -> dict[str, Any]:
        approval = await engine.resolve_approval(approval_id, "approved")
        if not approval:
            raise HTTPException(status_code=404, detail="approval_not_found")
        return {"approval_id": approval.approval_id, "status": approval.status}

    @app.post("/v1/approvals/{approval_id}/reject")
    async def reject(approval_id: str) -> dict[str, Any]:
        approval = await engine.resolve_approval(approval_id, "rejected")
        if not approval:
            raise HTTPException(status_code=404, detail="approval_not_found")
        return {"approval_id": approval.approval_id, "status": approval.status}

    return app
