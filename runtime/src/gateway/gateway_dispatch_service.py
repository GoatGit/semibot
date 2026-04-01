from __future__ import annotations

from typing import Any


async def prepare_gateway_execution(
    *,
    store: Any,
    provider: str,
    conversation: dict[str, Any],
    event_payload: dict[str, Any],
    text: str,
    attachments: list[dict[str, Any]],
    gateway_key: str,
    instance_id: str,
    bot_id: str,
    chat_id: str,
    user_message: dict[str, Any],
    resolve_fork_source_run: Any,
    requested_context_strategy: Any,
    build_execution_title: Any,
    build_task_input: Any,
    resolve_runtime_session_for_execution: Any,
) -> dict[str, Any]:
    context_strategy = requested_context_strategy(event_payload)
    parent_run = None
    if context_strategy == "fork":
        parent_run = await resolve_fork_source_run(
            conversation=conversation,
            event_payload=event_payload,
        )

    task_input = build_task_input(
        text=text,
        attachments=attachments,
        gateway_id=gateway_key,
        provider=provider,
        instance_id=instance_id,
        bot_id=bot_id,
        chat_id=chat_id,
    )
    runtime_session_id, forked_from_session_id = await resolve_runtime_session_for_execution(
        provider=provider,
        conversation=conversation,
        event_payload=event_payload,
    )
    title = build_execution_title(text)
    parent_run_id = str(parent_run.get("id") or "").strip() or None if isinstance(parent_run, dict) else None
    run = await store.acreate_task_run(
        conversation_id=conversation["id"],
        runtime_session_id=runtime_session_id,
        parent_run_id=parent_run_id,
        title=title,
        source_message_id=user_message["id"],
        snapshot_version=user_message["context_version"],
        context_strategy=context_strategy,
        status="created",
    )
    context_snapshot = await store.acreate_context_snapshot(
        execution_id=run["id"],
        strategy=context_strategy,
        schema_version="1.0",
        source_execution_id=parent_run_id,
        payload={
            "text": text,
            "attachments": attachments,
            "gateway_key": gateway_key,
            "provider": provider,
            "instance_id": instance_id,
            "bot_id": bot_id,
            "chat_id": chat_id,
            "source_message_id": user_message["id"],
            "snapshot_version": int(user_message["context_version"]),
            "task_input": task_input,
        },
    )
    run = await store.aupdate_task_run(
        run["id"],
        status="queued",
        parent_run_id=parent_run_id,
        title=title,
        context_strategy=context_strategy,
        context_snapshot_id=context_snapshot["id"],
    ) or run
    anchor = await store.acreate_interaction_anchor(
        conversation_id=conversation["id"],
        execution_id=run["id"],
        provider=provider,
        channel_target_id=chat_id,
        channel_message_id=run["id"],
        capability_mode="append_only",
    )
    run = await store.aupdate_task_run(
        run["id"],
        status=run["status"],
        anchor_id=anchor["id"],
    ) or run
    return {
        "run": run,
        "anchor": anchor,
        "task_input": task_input,
        "runtime_session_id": runtime_session_id,
        "context_strategy": context_strategy,
        "context_snapshot": context_snapshot,
        "forked_from_session_id": forked_from_session_id,
    }
