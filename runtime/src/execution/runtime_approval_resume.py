from __future__ import annotations

from dataclasses import asdict, dataclass
from datetime import UTC, datetime
from typing import Any
from uuid import uuid4

from src.checkpoint.local_checkpointer import LocalCheckpointer
from src.events.event_engine import EventEngine
from src.events.models import ApprovalRequest, Event


@dataclass
class ApprovalResumeContext:
    runtime_session_id: str | None
    approval_scope_id: str | None
    agent_id: str | None
    attempt_id: str | None
    user_message_id: str | None


@dataclass
class ApprovalResumeOutcome:
    resumed: bool
    session_id: str | None
    status: str | None
    error: str | None
    reason: str | None


@dataclass
class ApprovalActionResult:
    approval_id: str
    status: str
    approval_action_event_id: str
    attempt_id: str | None
    user_message_id: str | None
    resume: ApprovalResumeOutcome

    def to_dict(self) -> dict[str, Any]:
        return {
            "approval_id": self.approval_id,
            "status": self.status,
            "approval_action_event_id": self.approval_action_event_id,
            "attempt_id": self.attempt_id,
            "user_message_id": self.user_message_id,
            "resume": asdict(self.resume),
        }


@dataclass
class ApprovalResumeTaskConfig:
    task: str | None
    agent_id: str | None
    approval_scope_id: str | None
    model: str | None
    model_provider_key: str | None
    fallback_model: str | None
    fallback_provider_key: str | None
    system_prompt: str | None
    model_roles: dict[str, Any] | None


def build_approval_action_event(*, approval_id: str, command: str, decision: str) -> Event:
    return Event(
        event_id=f"evt_approval_action_{uuid4().hex}",
        event_type="approval.action",
        source="runtime.api",
        subject=approval_id,
        payload={
            "command": command,
            "decision": decision,
            "approval_ids": [approval_id],
            "resolved_count": 1,
            "scope": "api",
        },
        risk_hint="low",
        timestamp=datetime.now(UTC),
    )


def build_gateway_approval_action_event(
    *,
    target_ids: list[str],
    source: str,
    subject: str | None,
    decision: str,
    command: str,
    trace_payload: dict[str, Any] | None = None,
    action_idempotency_key: str | None = None,
    execution_id: str | None = None,
) -> Event:
    return Event(
        event_id=f"evt_approval_action_{uuid4().hex}",
        event_type="approval.action",
        source=source,
        subject=subject or (target_ids[0] if target_ids else None),
        idempotency_key=action_idempotency_key,
        payload={
            "command": command,
            "decision": decision,
            "approval_ids": target_ids,
            "resolved_count": 0,
            "scope": "gateway",
            "execution_id": execution_id,
            "raw": trace_payload or {},
        },
        risk_hint="low",
        timestamp=datetime.now(UTC),
    )


def extract_approval_resume_context(approval: ApprovalRequest) -> ApprovalResumeContext:
    context = approval.context if isinstance(getattr(approval, "context", None), dict) else {}
    runtime_session_id = str(context.get("runtime_session_id") or context.get("session_id") or "").strip() or None
    approval_scope_id = str(context.get("approval_scope_id") or "").strip() or None
    agent_id = str(context.get("agent_id") or "").strip() or None
    attempt_id = str(approval.attempt_id or context.get("attempt_id") or "").strip() or None
    user_message_id = str(approval.user_message_id or context.get("user_message_id") or "").strip() or None
    return ApprovalResumeContext(
        runtime_session_id=runtime_session_id,
        approval_scope_id=approval_scope_id,
        agent_id=agent_id,
        attempt_id=attempt_id,
        user_message_id=user_message_id,
    )


async def load_resume_message(
    *,
    checkpointer: LocalCheckpointer,
    session_id: str,
) -> str | None:
    latest = await checkpointer.load_latest(session_id)
    if not isinstance(latest, dict):
        return None
    message = str(latest.get("last_user_message") or "").strip()
    if message:
        return message
    history = latest.get("conversation_history")
    if not isinstance(history, list):
        history = latest.get("history")
    if isinstance(history, list):
        for item in reversed(history):
            if not isinstance(item, dict):
                continue
            if str(item.get("role") or "").strip().lower() != "user":
                continue
            text = str(item.get("content") or "").strip()
            if text and not text.startswith("[SYSTEM]"):
                return text
    return None


def _read_optional_string(record: dict[str, Any], key: str) -> str | None:
    value = record.get(key)
    if isinstance(value, str):
        text = value.strip()
        if text:
            return text
    return None


def _extract_resume_task_config(latest: dict[str, Any]) -> ApprovalResumeTaskConfig:
    resume_cfg = latest.get("resume_task_config")
    if not isinstance(resume_cfg, dict):
        resume_cfg = {}
    model_roles = resume_cfg.get("model_roles")
    if not isinstance(model_roles, dict):
        model_roles = None
    return ApprovalResumeTaskConfig(
        task=None,
        agent_id=_read_optional_string(resume_cfg, "agent_id"),
        approval_scope_id=_read_optional_string(resume_cfg, "approval_scope_id"),
        model=_read_optional_string(resume_cfg, "model"),
        model_provider_key=_read_optional_string(resume_cfg, "model_provider_key"),
        fallback_model=_read_optional_string(resume_cfg, "fallback_model"),
        fallback_provider_key=_read_optional_string(resume_cfg, "fallback_provider_key"),
        system_prompt=_read_optional_string(resume_cfg, "system_prompt"),
        model_roles=model_roles,
    )


async def load_resume_task_config(
    *,
    checkpointer: LocalCheckpointer,
    session_id: str,
) -> ApprovalResumeTaskConfig | None:
    latest = await checkpointer.load_latest(session_id)
    if not isinstance(latest, dict):
        return None
    resume = _extract_resume_task_config(latest)
    resume.task = await load_resume_message(checkpointer=checkpointer, session_id=session_id)
    return resume


def _normalize_resume_outcome(
    *,
    resumed: bool,
    session_id: str | None = None,
    status: str | None = None,
    error: str | None = None,
    reason: str | None = None,
) -> ApprovalResumeOutcome:
    return ApprovalResumeOutcome(
        resumed=resumed,
        session_id=session_id,
        status=status,
        error=error,
        reason=reason,
    )


async def approve_and_maybe_resume(
    *,
    engine: EventEngine,
    checkpointer: LocalCheckpointer,
    approval_id: str,
    db_path: str,
    rules_path: str,
    task_runner: Any,
    gateway_context: Any | None = None,
    auto_resume: bool = True,
) -> ApprovalActionResult | None:
    approval = await engine.resolve_approval(approval_id, "approved")
    if not approval:
        return None

    approval_action_event = build_approval_action_event(
        approval_id=approval.approval_id,
        command="approve",
        decision="approved",
    )
    await engine.emit(approval_action_event)

    context = extract_approval_resume_context(approval)
    if not auto_resume:
        return ApprovalActionResult(
            approval_id=approval.approval_id,
            status=approval.status,
            approval_action_event_id=approval_action_event.event_id,
            attempt_id=context.attempt_id,
            user_message_id=context.user_message_id,
            resume=_normalize_resume_outcome(
                resumed=False,
                session_id=context.runtime_session_id,
                reason="resume_deferred",
            ),
        )

    if gateway_context is not None:
        matched_runs = await gateway_context.find_executions_for_approval_ids(
            approval_ids=[approval.approval_id],
            conversation_id=None,
            statuses=["awaiting_approval"],
        )
        if not matched_runs:
            return ApprovalActionResult(
                approval_id=approval.approval_id,
                status=approval.status,
                approval_action_event_id=approval_action_event.event_id,
                attempt_id=context.attempt_id,
                user_message_id=context.user_message_id,
                resume=_normalize_resume_outcome(
                    resumed=False,
                    session_id=context.runtime_session_id,
                    reason="gateway_execution_not_found",
                ),
            )
        for run in matched_runs:
            execution_id = str(run.get("id") or "").strip()
            conversation_id = str(run.get("conversation_id") or "").strip()
            if not execution_id or not conversation_id:
                continue
            conversation = await gateway_context.store.aget_conversation(conversation_id)
            if not conversation:
                continue
            provider = str(conversation.get("provider") or "").strip()
            chat_id = str(conversation.get("chat_id") or "").strip()
            if not provider or not chat_id:
                continue
            resumed = await gateway_context.resume_execution(
                provider=provider,
                execution_id=execution_id,
                chat_id=chat_id,
                agent_id=context.agent_id or "semibot",
                on_result=None,
            )
            if resumed.get("resumed"):
                return ApprovalActionResult(
                    approval_id=approval.approval_id,
                    status=approval.status,
                    approval_action_event_id=approval_action_event.event_id,
                    attempt_id=context.attempt_id,
                    user_message_id=context.user_message_id,
                    resume=_normalize_resume_outcome(
                        resumed=True,
                        session_id=str(resumed.get("runtime_session_id") or "") or None,
                        status="queued",
                        reason=None,
                    ),
                )
        return ApprovalActionResult(
            approval_id=approval.approval_id,
            status=approval.status,
            approval_action_event_id=approval_action_event.event_id,
            attempt_id=context.attempt_id,
            user_message_id=context.user_message_id,
            resume=_normalize_resume_outcome(
                resumed=False,
                session_id=context.runtime_session_id,
                reason="gateway_execution_resume_failed",
            ),
        )

    if not context.runtime_session_id:
        return ApprovalActionResult(
            approval_id=approval.approval_id,
            status=approval.status,
            approval_action_event_id=approval_action_event.event_id,
            attempt_id=context.attempt_id,
            user_message_id=context.user_message_id,
            resume=_normalize_resume_outcome(
                resumed=False,
                reason="missing_runtime_session_id",
            ),
        )

    resume_config = await load_resume_task_config(
        checkpointer=checkpointer,
        session_id=context.runtime_session_id,
    )
    resume_message = resume_config.task if isinstance(resume_config, ApprovalResumeTaskConfig) else None
    if not resume_message:
        return ApprovalActionResult(
            approval_id=approval.approval_id,
            status=approval.status,
            approval_action_event_id=approval_action_event.event_id,
            attempt_id=context.attempt_id,
            user_message_id=context.user_message_id,
            resume=_normalize_resume_outcome(
                resumed=False,
                session_id=context.runtime_session_id,
                reason="missing_resume_message",
            ),
        )

    try:
        resumed = await task_runner(
            task=resume_message,
            db_path=db_path,
            rules_path=rules_path,
            agent_id=context.agent_id or (resume_config.agent_id if resume_config else None) or "semibot",
            session_id=context.runtime_session_id,
            approval_scope_id=context.approval_scope_id or (resume_config.approval_scope_id if resume_config else None),
            attempt_id=context.attempt_id,
            user_message_id=context.user_message_id,
            model=resume_config.model if resume_config else None,
            model_provider_key=resume_config.model_provider_key if resume_config else None,
            fallback_model=resume_config.fallback_model if resume_config else None,
            fallback_provider_key=resume_config.fallback_provider_key if resume_config else None,
            system_prompt=resume_config.system_prompt if resume_config else None,
            model_roles=resume_config.model_roles if resume_config else None,
        )
    except Exception as exc:
        return ApprovalActionResult(
            approval_id=approval.approval_id,
            status=approval.status,
            approval_action_event_id=approval_action_event.event_id,
            attempt_id=context.attempt_id,
            user_message_id=context.user_message_id,
            resume=_normalize_resume_outcome(
                resumed=False,
                session_id=context.runtime_session_id,
                reason=f"resume_failed:{exc}",
            ),
        )

    return ApprovalActionResult(
        approval_id=approval.approval_id,
        status=approval.status,
        approval_action_event_id=approval_action_event.event_id,
        attempt_id=context.attempt_id,
        user_message_id=context.user_message_id,
        resume=_normalize_resume_outcome(
            resumed=True,
            session_id=context.runtime_session_id,
            status=str(resumed.get("status") or ""),
            error=str(resumed.get("error") or "") or None,
            reason=None,
        ),
    )


async def gateway_resolve_approval_command(
    *,
    engine: EventEngine,
    target_ids: list[str],
    decision: str,
    source: str,
    subject: str | None,
    trace_payload: dict[str, Any] | None = None,
    action_idempotency_key: str | None = None,
    execution_id: str | None = None,
) -> dict[str, Any]:
    resolved_items: list[Any] = []
    for approval_id in target_ids:
        resolved = await engine.resolve_approval(approval_id, decision)
        if resolved:
            resolved_items.append(resolved)

    approval_action_event = build_gateway_approval_action_event(
        target_ids=target_ids,
        source=source,
        subject=subject,
        decision=decision,
        command="approve_all" if len(target_ids) > 1 and decision == "approved" else "reject_all" if len(target_ids) > 1 else "approve" if decision == "approved" else "reject",
        trace_payload=trace_payload,
        action_idempotency_key=action_idempotency_key,
        execution_id=execution_id,
    )
    payload = approval_action_event.payload if isinstance(approval_action_event.payload, dict) else {}
    payload["resolved_count"] = len(resolved_items)
    approval_action_event.payload = payload
    await engine.emit(approval_action_event)

    return {
        "recognized": True,
        "resolved": len(resolved_items) > 0,
        "resolved_count": len(resolved_items),
        "approval_ids": [item.approval_id for item in resolved_items],
        "status": decision,
        "execution_id": execution_id,
        "event_id": approval_action_event.event_id,
    }


async def reject_and_finalize(
    *,
    engine: EventEngine,
    approval_id: str,
) -> ApprovalActionResult | None:
    approval = await engine.resolve_approval(approval_id, "rejected")
    if not approval:
        return None

    approval_action_event = build_approval_action_event(
        approval_id=approval.approval_id,
        command="reject",
        decision="rejected",
    )
    await engine.emit(approval_action_event)
    return ApprovalActionResult(
        approval_id=approval.approval_id,
        status=approval.status,
        approval_action_event_id=approval_action_event.event_id,
        attempt_id=approval.attempt_id,
        user_message_id=approval.user_message_id,
        resume=_normalize_resume_outcome(
            resumed=False,
            reason="rejected",
        ),
    )
