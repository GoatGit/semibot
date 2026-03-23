"""Post-MVP capability resolution, approval, install, and retry helpers."""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import Any

from src.gateway.store.gateway_store import GatewayStore
from src.orchestrator.missing_capability import (
    build_missing_capability_query,
    build_missing_capability_recommendation,
)
from src.orchestrator.state import MissingCapability
from src.orchestrator.tool_registry import search_tool_registry
from src.orchestrator.tool_installer import install_tool_from_registry
from src.skills.registry import SkillRegistry
from src.skills.skill_installer import _install_from_registry

TaskRunner = Callable[..., Awaitable[dict[str, Any]]]


async def _append_install_audit(
    *,
    store: GatewayStore,
    request_id: str,
    event_type: str,
    detail: dict[str, Any] | None = None,
) -> None:
    await store.aappend_capability_install_audit_event(
        request_id,
        {
            "eventType": event_type,
            **dict(detail or {}),
        },
    )


def _recommended_tool_id(entry: Any) -> str:
    tool_id = str(getattr(entry, "tool_id", "") or "").strip()
    if tool_id:
        return tool_id
    to_dict = getattr(entry, "to_dict", None)
    if callable(to_dict):
        payload = to_dict()
        if isinstance(payload, dict):
            return str(payload.get("toolId") or "").strip()
    return ""


def _entry_field(entry: Any, attr_name: str, payload_key: str) -> str:
    value = str(getattr(entry, attr_name, "") or "").strip()
    if value:
        return value
    to_dict = getattr(entry, "to_dict", None)
    if callable(to_dict):
        payload = to_dict()
        if isinstance(payload, dict):
            return str(payload.get(payload_key) or "").strip()
    return ""


def normalize_missing_capability(raw_missing: dict[str, Any] | None) -> MissingCapability:
    raw = raw_missing or {}
    required_capabilities = raw.get("required_capabilities")
    if required_capabilities is None:
        required_capabilities = raw.get("requiredCapabilities")
    preferred_sources = raw.get("preferred_sources")
    if preferred_sources is None:
        preferred_sources = raw.get("preferredSources")
    return MissingCapability(
        type=str(raw.get("type") or "missing_capability"),
        version=str(raw.get("version") or "1"),
        intent=str(raw.get("intent") or "").strip(),
        reason=str(raw.get("reason") or "").strip(),
        required_capabilities=[
            str(item or "").strip()
            for item in (required_capabilities or [])
            if str(item or "").strip()
        ],
        preferred_sources=[
            str(item or "").strip()
            for item in (preferred_sources or [])
            if str(item or "").strip()
        ],
    )


async def resolve_missing_capability_request(
    *,
    store: GatewayStore,
    missing_capability: MissingCapability,
    query: str | None,
    task_id: str | None,
    session_id: str | None,
    task_text: str | None,
    current_shortlist_tool_ids: list[str] | None,
) -> dict[str, Any]:
    resolved_query = str(query or "").strip() or build_missing_capability_query(missing_capability)
    tool_candidates = search_tool_registry(resolved_query, missing_capability=missing_capability)
    if not tool_candidates:
        return {
            "ok": False,
            "code": "CAPABILITY_CANDIDATE_NOT_FOUND",
            "message": "no install candidate found for missing capability",
            "missing_capability": missing_capability.model_dump(),
            "query": resolved_query,
        }
    selected_tool = tool_candidates[0]
    registry_name = selected_tool.registry_name
    install_path = _entry_field(selected_tool, "install_path", "installPath")
    source_type = _entry_field(selected_tool, "source_type", "sourceType")
    target_type = "tool" if install_path == "tool_installer" or source_type == "cli" else "skill"

    recommendation = build_missing_capability_recommendation(
        missing_capability,
        query=resolved_query,
        registry_name=registry_name,
        recommended_tools=tool_candidates,
        recommended_skills=None,
    )
    install_request = await store.acreate_capability_install_request(
        task_id=task_id,
        session_id=session_id,
        target_type=target_type,
        target_id=registry_name,
        approval_mode="pending",
        state="awaiting_approval",
        metadata={
            "missing_capability": missing_capability.model_dump(),
            "query": resolved_query,
            "recommendation": recommendation,
            "task_text": str(task_text or "").strip() or None,
            "current_shortlist_tool_ids": list(current_shortlist_tool_ids or []),
            "selected_candidate": {
                "toolId": _recommended_tool_id(selected_tool),
                "registryName": _entry_field(selected_tool, "registry_name", "registryName"),
                "sourceType": _entry_field(selected_tool, "source_type", "sourceType"),
                "installPath": _entry_field(selected_tool, "install_path", "installPath"),
                "displayName": _entry_field(selected_tool, "display_name", "displayName"),
            },
        },
    )
    await _append_install_audit(
        store=store,
        request_id=install_request["id"],
        event_type="resolved_missing_capability",
        detail={
            "registryName": registry_name,
            "recommendedToolIds": [tool_id for item in tool_candidates[:5] if (tool_id := _recommended_tool_id(item))],
        },
    )
    return {
        "ok": True,
        "data": {
            **recommendation,
            "install_request_id": install_request["id"],
        },
    }


async def approve_capability_install_request(
    *,
    store: GatewayStore,
    registry: SkillRegistry,
    request_id: str,
    approved: bool,
) -> dict[str, Any]:
    install_request = await store.aget_capability_install_request(request_id)
    if not install_request:
        return {
            "ok": False,
            "code": "INSTALL_REQUEST_NOT_FOUND",
            "message": "install request not found",
        }

    if not approved:
        updated = await store.aupdate_capability_install_request(
            request_id,
            approval_mode="denied",
            state="cancelled",
            metadata={"approval": {"approved": False}},
            error_text="install rejected",
        )
        await _append_install_audit(
            store=store,
            request_id=request_id,
            event_type="install_denied",
            detail={"approved": False},
        )
        refreshed = await store.aget_capability_install_request(request_id)
        return {"ok": True, "data": refreshed or updated}

    metadata = dict(install_request.get("metadata") or {})
    target_type = str(install_request.get("target_type") or "skill")
    target_id = str(install_request.get("target_id") or "").strip()
    await store.aupdate_capability_install_request(
        request_id,
        approval_mode="user_confirmed",
        state="installing",
        metadata={"approval": {"approved": True}},
        error_text=None,
    )
    await _append_install_audit(
        store=store,
        request_id=request_id,
        event_type="install_approved",
        detail={"approved": True, "targetType": target_type, "targetId": target_id},
    )
    try:
        if target_type == "tool":
            install_result = install_tool_from_registry(
                registry=registry,
                registry_name=target_id,
            )
        else:
            install_result = _install_from_registry(
                registry=registry,
                registry_name=target_id,
            )
        await store.aupdate_capability_install_request(
            request_id,
            state="refreshing_catalog",
            metadata={"install_result": install_result},
            error_text=None,
        )
        await _append_install_audit(
            store=store,
            request_id=request_id,
            event_type="install_completed",
            detail={"targetType": target_type, "targetId": target_id},
        )
        updated = await store.aupdate_capability_install_request(
            request_id,
            state="completed",
            metadata={"install_result": install_result, "completed_via": "approve_install"},
            error_text=None,
        )
        refreshed = await store.aget_capability_install_request(request_id)
        return {"ok": True, "data": refreshed or updated}
    except Exception as exc:
        failed = await store.aupdate_capability_install_request(
            request_id,
            state="failed",
            metadata=metadata,
            error_text=str(exc),
        )
        await _append_install_audit(
            store=store,
            request_id=request_id,
            event_type="install_failed",
            detail={"targetType": target_type, "targetId": target_id, "error": str(exc)},
        )
        refreshed = await store.aget_capability_install_request(request_id)
        return {
            "ok": False,
            "code": "CAPABILITY_INSTALL_FAILED",
            "message": str(exc),
            "data": refreshed or failed,
        }


async def retry_capability_install_request_task(
    *,
    store: GatewayStore,
    request_id: str,
    task_runner: TaskRunner,
) -> dict[str, Any]:
    install_request = await store.aget_capability_install_request(request_id)
    if not install_request:
        return {
            "ok": False,
            "code": "INSTALL_REQUEST_NOT_FOUND",
            "message": "install request not found",
        }

    metadata = dict(install_request.get("metadata") or {})
    task_text = str(metadata.get("task_text") or "").strip()
    if not task_text:
        return {
            "ok": False,
            "code": "RETRY_TASK_TEXT_REQUIRED",
            "message": "retry requires original task_text",
        }

    await store.aupdate_capability_install_request(
        request_id,
        state="retrying_task",
        metadata={"retry_started": True},
        error_text=None,
    )
    await _append_install_audit(
        store=store,
        request_id=request_id,
        event_type="retry_started",
        detail={"taskText": task_text[:500]},
    )
    try:
        retry_result = await task_runner(
            task=task_text,
            session_id=install_request.get("session_id"),
            agent_id="semibot",
        )
        updated = await store.aupdate_capability_install_request(
            request_id,
            state="completed",
            metadata={"retry_result": retry_result},
            error_text=None,
        )
        await _append_install_audit(
            store=store,
            request_id=request_id,
            event_type="retry_completed",
            detail={"status": str(retry_result.get("status") or "")},
        )
        refreshed = await store.aget_capability_install_request(request_id)
        return {"ok": True, "data": refreshed or updated}
    except Exception as exc:
        failed = await store.aupdate_capability_install_request(
            request_id,
            state="failed",
            metadata={},
            error_text=str(exc),
        )
        await _append_install_audit(
            store=store,
            request_id=request_id,
            event_type="retry_failed",
            detail={"error": str(exc)},
        )
        refreshed = await store.aget_capability_install_request(request_id)
        return {
            "ok": False,
            "code": "RETRY_TASK_FAILED",
            "message": str(exc),
            "data": refreshed or failed,
        }
