from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from contextlib import suppress
from typing import Any

from src.constants.config import GATEWAY_APPROVAL_POLL_INTERVAL_SECONDS
from src.gateway.gateway_execution_facade import (
    mark_execution_awaiting_approval,
    mark_execution_done,
    mark_execution_failed,
)

ReplySender = Callable[[str, dict[str, Any]], Awaitable[bool]]


async def execute_gateway_run(
    *,
    store: Any,
    config_store: Any,
    provider: str,
    conversation: dict[str, Any],
    run: dict[str, Any],
    runtime_session_id: str,
    task_input: str,
    approval_scope_id: str,
    chat_id: str,
    agent_id: str,
    task_timeout_seconds: int,
    on_result: ReplySender | None,
    run_execution_via_runtime_facade: Callable[..., Awaitable[dict[str, Any]]],
    agent_runtime_config: dict[str, Any],
    summarize_recent_tool_usage: Callable[..., Awaitable[dict[str, int]]],
    pending_approval_ids_for_scope: Callable[[str], Awaitable[list[str]]],
    resolve_awaiting_approval_notice: Callable[..., str],
    format_plan_preview_message: Callable[[list[dict[str, Any]]], str],
    extract_generated_files: Callable[[dict[str, Any]], list[dict[str, Any]]],
    extract_pending_approval_ids: Callable[[dict[str, Any]], list[str]],
    extract_missing_capability: Callable[[dict[str, Any]], dict[str, Any] | None],
    extract_proposed_cli_import: Callable[[dict[str, Any]], dict[str, Any] | None],
    extract_tool_usage_events: Callable[[dict[str, Any]], list[dict[str, Any]]],
    append_cli_import_hint: Callable[[str, str], str],
) -> None:
    anchor_id = str(run.get("anchor_id") or "").strip() or None
    await store.aupdate_task_run(run["id"], status="running")
    await store.aupdate_active_runtime_session_status(
        conversation["id"],
        runtime_session_id=runtime_session_id,
        status="running",
    )
    plan_preview_sent = False

    async def _runtime_event_callback(runtime_event: dict[str, Any]) -> None:
        nonlocal plan_preview_sent
        if plan_preview_sent or not on_result:
            return
        if str(runtime_event.get("event") or "") != "plan_created":
            return
        payload = runtime_event.get("data")
        data = payload if isinstance(payload, dict) else {}
        steps = data.get("steps")
        steps_list = steps if isinstance(steps, list) else []
        text_preview = format_plan_preview_message(
            [item for item in steps_list if isinstance(item, dict)]
        )
        ok = await on_result(
            text_preview,
            {
                "chat_id": chat_id,
                "conversation_id": conversation["id"],
                "task_run_id": run["id"],
                "runtime_session_id": runtime_session_id,
                "anchor_id": anchor_id,
                "status": "planning",
            },
        )
        if ok:
            plan_preview_sent = True

    try:
        recent_tool_usage = await summarize_recent_tool_usage(
            session_id=runtime_session_id,
            limit=100,
            success_only=True,
        )
        runner_task = asyncio.create_task(
            run_execution_via_runtime_facade(
                run=run,
                task_input=task_input,
                runtime_session_id=runtime_session_id,
                approval_scope_id=approval_scope_id,
                agent_id=agent_id,
                agent_runtime_config=agent_runtime_config,
                recent_tool_usage=recent_tool_usage,
                runtime_event_callback=_runtime_event_callback,
            )
        )
        deadline = asyncio.get_running_loop().time() + float(task_timeout_seconds)
        runtime_result: dict[str, Any] | None = None
        while runtime_result is None:
            now = asyncio.get_running_loop().time()
            remaining = deadline - now
            if remaining <= 0:
                raise TimeoutError

            done, _ = await asyncio.wait({runner_task}, timeout=min(GATEWAY_APPROVAL_POLL_INTERVAL_SECONDS, remaining))
            if runner_task in done:
                runtime_result = await runner_task
                break

            if runner_task.done():
                runtime_result = await runner_task
                break

            pending_approval_ids = await pending_approval_ids_for_scope(approval_scope_id)
            if pending_approval_ids:
                runner_task.cancel()
                with suppress(asyncio.CancelledError):
                    await runner_task

                msg = resolve_awaiting_approval_notice(
                    approval_ids=pending_approval_ids,
                    fallback_message="操作需要人工审批后继续。",
                )
                await mark_execution_awaiting_approval(
                    store=store,
                    conversation=conversation,
                    run=run,
                    runtime_session_id=runtime_session_id,
                    chat_id=chat_id,
                    anchor_id=anchor_id,
                    message=msg,
                    approval_ids=pending_approval_ids,
                    binding_source="poll",
                    on_result=on_result,
                )
                return

        if runtime_result is None:
            raise TimeoutError
        final_response = str(runtime_result.get("final_response") or "").strip()
        error = str(runtime_result.get("error") or "").strip()
        generated_files = extract_generated_files(runtime_result)
        approval_ids = extract_pending_approval_ids(runtime_result)
        normalized_runtime_status = str(runtime_result.get("status") or "").strip().lower()
        missing_capability = extract_missing_capability(runtime_result)
        proposed_cli_import = extract_proposed_cli_import(runtime_result)
        tool_usage_events = extract_tool_usage_events(runtime_result)
        for event in tool_usage_events:
            await store.acreate_tool_usage_event(
                session_id=runtime_session_id,
                task_run_id=event["task_run_id"],
                tool_id=event["tool_id"],
                tool_name=event["tool_name"],
                actual_tool_name=event["actual_tool_name"],
                source_type=event["source_type"],
                success=bool(event["success"]),
                metadata=event.get("metadata") if isinstance(event.get("metadata"), dict) else None,
            )
        if approval_ids or normalized_runtime_status == "awaiting_approval":
            msg = resolve_awaiting_approval_notice(
                runtime_result=runtime_result,
                approval_ids=approval_ids,
                fallback_message=final_response or "操作需要人工审批后继续。",
            )
            await mark_execution_awaiting_approval(
                store=store,
                conversation=conversation,
                run=run,
                runtime_session_id=runtime_session_id,
                chat_id=chat_id,
                anchor_id=anchor_id,
                message=msg,
                approval_ids=approval_ids,
                binding_source="runtime_result",
                runtime_result=runtime_result,
                on_result=on_result,
            )
            return
        if normalized_runtime_status in {"failed", "cancelled"}:
            msg = error or ("任务已取消。" if normalized_runtime_status == "cancelled" else "任务执行失败。")
            await mark_execution_failed(
                store=store,
                conversation=conversation,
                run=run,
                runtime_session_id=runtime_session_id,
                chat_id=chat_id,
                anchor_id=anchor_id,
                message=msg,
                status="failed" if normalized_runtime_status == "cancelled" else normalized_runtime_status,
                error=error or None,
                runtime_result=runtime_result,
                on_result=on_result,
            )
            return
        if not final_response:
            final_response = "任务已执行，但没有可返回结果。"
        await mark_execution_done(
            store=store,
            config_store=config_store,
            provider=provider,
            conversation=conversation,
            run=run,
            runtime_session_id=runtime_session_id,
            chat_id=chat_id,
            anchor_id=anchor_id,
            final_response=final_response,
            generated_files=generated_files,
            missing_capability=missing_capability,
            proposed_cli_import=proposed_cli_import,
            runtime_result=runtime_result,
            on_result=on_result,
            append_cli_import_hint=append_cli_import_hint,
        )
    except TimeoutError:
        msg = f"任务执行超时（>{task_timeout_seconds}s），请重试或缩小任务范围。"
        await mark_execution_failed(
            store=store,
            conversation=conversation,
            run=run,
            runtime_session_id=runtime_session_id,
            chat_id=chat_id,
            anchor_id=anchor_id,
            message=msg,
            status="failed",
            error="timeout",
            on_result=on_result,
        )
    except Exception as exc:  # noqa: BLE001
        msg = f"任务执行失败：{exc}"
        await mark_execution_failed(
            store=store,
            conversation=conversation,
            run=run,
            runtime_session_id=runtime_session_id,
            chat_id=chat_id,
            anchor_id=anchor_id,
            message=msg,
            status="failed",
            error=str(exc),
            on_result=on_result,
        )


async def resume_gateway_execution(
    *,
    store: Any,
    provider: str,
    execution_id: str,
    chat_id: str,
    agent_id: str,
    on_result: ReplySender | None,
    fork_runtime_session: Callable[..., str],
    spawn_execution_task: Callable[..., Any],
) -> dict[str, Any]:
    run = await store.aget_task_run(execution_id)
    if not run:
        return {"resumed": False, "reason": "execution_not_found", "execution_id": execution_id}
    if str(run.get("status") or "") != "awaiting_approval":
        return {
            "resumed": False,
            "reason": "execution_not_awaiting_approval",
            "execution_id": execution_id,
            "status": run.get("status"),
        }
    snapshot_id = str(run.get("context_snapshot_id") or "").strip()
    if not snapshot_id:
        return {"resumed": False, "reason": "context_snapshot_missing", "execution_id": execution_id}
    snapshot = await store.aget_context_snapshot(snapshot_id)
    if not snapshot:
        return {"resumed": False, "reason": "context_snapshot_not_found", "execution_id": execution_id}
    conversation_id = str(run.get("conversation_id") or "").strip()
    conversation = await store.aget_conversation(conversation_id)
    if not conversation:
        return {"resumed": False, "reason": "conversation_not_found", "execution_id": execution_id}
    payload = snapshot.get("payload") if isinstance(snapshot.get("payload"), dict) else {}
    task_input = str(payload.get("task_input") or "").strip()
    if not task_input:
        return {"resumed": False, "reason": "task_input_missing", "execution_id": execution_id}
    source_message_id = str(run.get("source_message_id") or payload.get("source_message_id") or "").strip()
    approval_scope_id = source_message_id or execution_id
    previous_runtime_session_id = str(run.get("runtime_session_id") or "").strip()
    runtime_session_id = fork_runtime_session(
        provider=provider,
        source_session_id=previous_runtime_session_id,
    )
    claimed_run = await store.aclaim_task_run_for_resume(
        run["id"],
        from_status="awaiting_approval",
        to_status="queued",
        runtime_session_id=runtime_session_id,
    )
    if not claimed_run:
        return {
            "resumed": False,
            "reason": "execution_not_awaiting_approval",
            "execution_id": execution_id,
            "status": str((await store.aget_task_run(execution_id) or {}).get("status") or "") or None,
        }
    run = claimed_run
    await store.aset_active_runtime_session(
        conversation["id"],
        runtime_session_id=runtime_session_id,
        status="queued",
        forked_from_session_id=previous_runtime_session_id or None,
    )
    spawn_execution_task(
        provider=provider,
        conversation=conversation,
        run=run,
        runtime_session_id=runtime_session_id,
        task_input=task_input,
        approval_scope_id=approval_scope_id,
        chat_id=chat_id,
        agent_id=agent_id,
        on_result=on_result,
    )
    return {
        "resumed": True,
        "conversation_id": conversation_id,
        "task_run_id": execution_id,
        "runtime_session_id": runtime_session_id,
        "agent_id": agent_id,
    }
