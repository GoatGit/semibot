from __future__ import annotations

import logging
from typing import Any

from src.server.cli_import_service import create_cli_import_request
from src.skills.bootstrap import create_default_registry

logger = logging.getLogger(__name__)


async def mark_execution_awaiting_approval(
    *,
    store: Any,
    conversation: dict[str, Any],
    run: dict[str, Any],
    runtime_session_id: str,
    chat_id: str,
    anchor_id: str | None,
    message: str,
    approval_ids: list[str],
    binding_source: str,
    runtime_result: dict[str, Any] | None = None,
    on_result: Any | None = None,
) -> None:
    await store.aupdate_task_run(
        run["id"],
        status="awaiting_approval",
        result_summary=message,
        approval_binding={
            "approval_ids": approval_ids,
            "binding_source": binding_source,
        },
        result_metadata={
            "status": "awaiting_approval",
            "notice_kind": "awaiting_approval",
            "approval_ids": approval_ids,
            **({"runtime_result": runtime_result} if isinstance(runtime_result, dict) else {}),
        },
    )
    await store.aupdate_active_runtime_session_status(
        conversation["id"],
        runtime_session_id=runtime_session_id,
        status="awaiting_approval",
    )
    if on_result:
        await on_result(
            message,
            {
                "chat_id": chat_id,
                "conversation_id": conversation["id"],
                "task_run_id": run["id"],
                "runtime_session_id": runtime_session_id,
                "anchor_id": anchor_id,
                "status": "awaiting_approval",
                "notice_kind": "awaiting_approval",
                "approval_ids": approval_ids,
            },
        )


async def mark_execution_failed(
    *,
    store: Any,
    conversation: dict[str, Any],
    run: dict[str, Any],
    runtime_session_id: str,
    chat_id: str,
    anchor_id: str | None,
    message: str,
    status: str,
    error: str | None = None,
    runtime_result: dict[str, Any] | None = None,
    on_result: Any | None = None,
) -> None:
    await store.aupdate_task_run(
        run["id"],
        status=status,
        result_summary=message,
        result_metadata={
            "status": status,
            "notice_kind": "error",
            "error": error or None,
            **({"runtime_result": runtime_result} if isinstance(runtime_result, dict) else {}),
        },
    )
    await store.aupdate_active_runtime_session_status(
        conversation["id"],
        runtime_session_id=runtime_session_id,
        status=status,
    )
    if on_result:
        await on_result(
            message,
            {
                "chat_id": chat_id,
                "conversation_id": conversation["id"],
                "task_run_id": run["id"],
                "runtime_session_id": runtime_session_id,
                "anchor_id": anchor_id,
                "status": status,
                **({"error": error} if error else {}),
                "notice_kind": "error",
            },
        )


async def mark_execution_done(
    *,
    store: Any,
    config_store: Any,
    provider: str,
    conversation: dict[str, Any],
    run: dict[str, Any],
    runtime_session_id: str,
    chat_id: str,
    anchor_id: str | None,
    final_response: str,
    generated_files: list[dict[str, Any]],
    missing_capability: dict[str, Any] | None,
    proposed_cli_import: dict[str, Any] | None,
    runtime_result: dict[str, Any],
    on_result: Any | None = None,
    append_cli_import_hint: Any | None = None,
) -> None:
    cli_import_request = None
    if proposed_cli_import:
        try:
            cli_registry = create_default_registry()
            cli_import_request = await create_cli_import_request(
                config_store=config_store,
                registry=cli_registry,
                command=[str(item) for item in (proposed_cli_import.get("command") or []) if str(item or "").strip()],
                shape="group" if str(proposed_cli_import.get("shape") or "") == "group" else "direct",
                source="channel_auto",
                requested_by=provider,
                display_name=str(proposed_cli_import.get("display_name") or proposed_cli_import.get("displayName") or "").strip() or None,
                description=str(proposed_cli_import.get("description") or "").strip() or None,
                tool_name=str(proposed_cli_import.get("tool_name") or proposed_cli_import.get("toolName") or "").strip() or None,
                reason=str(proposed_cli_import.get("reason") or "").strip() or None,
            )
            if append_cli_import_hint:
                final_response = append_cli_import_hint(final_response, str(cli_import_request.get("id") or ""))
        except Exception as exc:  # noqa: BLE001
            logger.warning("gateway_cli_import_request_failed", extra={"error": str(exc), "provider": provider})

    await store.aupdate_task_run(
        run["id"],
        status="done",
        result_summary=final_response,
        approval_binding={},
        result_metadata={
            "runtime_result": runtime_result,
            "generated_files": generated_files,
            "missing_capability": missing_capability,
            "proposed_cli_import": proposed_cli_import,
            "cli_import_request": cli_import_request,
        },
    )
    await store.aupdate_active_runtime_session_status(
        conversation["id"],
        runtime_session_id=runtime_session_id,
        status="idle",
    )
    await store.aappend_context_message(
        conversation_id=conversation["id"],
        role="assistant",
        content=final_response,
        metadata={
            "provider": provider,
            "task_run_id": run["id"],
            "runtime_session_id": runtime_session_id,
            "minimal_writeback": True,
            "generated_files": generated_files,
            "missing_capability": missing_capability,
            "proposed_cli_import": proposed_cli_import,
            "cli_import_request": cli_import_request,
        },
    )
    if on_result:
        await on_result(
            final_response,
            {
                "chat_id": chat_id,
                "conversation_id": conversation["id"],
                "task_run_id": run["id"],
                "runtime_session_id": runtime_session_id,
                "anchor_id": anchor_id,
                "files": generated_files,
                "cli_import_request": cli_import_request,
            },
        )
