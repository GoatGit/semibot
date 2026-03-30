from __future__ import annotations

import logging
from collections.abc import Mapping
from typing import TYPE_CHECKING, Any

from src.gateway.channels.shared import format_approval_notice, query_value

if TYPE_CHECKING:
    from src.gateway.manager import GatewayManager

logger = logging.getLogger(__name__)


def _query_value(query_params: Mapping[str, str] | None, *keys: str) -> str | None:
    return query_value(query_params, *keys)


def resolve_instance_for_ingest(
    manager: GatewayManager,
    *,
    query_params: Mapping[str, str] | None,
) -> dict[str, Any] | None:
    from src.gateway.manager import GatewayManagerError

    instance_id = _query_value(query_params, "instanceId", "instance_id")
    if instance_id:
        item = manager._get_instance(instance_id)  # noqa: SLF001
        if item and str(item.get("provider")) == "imessage":
            return item
        raise GatewayManagerError("gateway_instance_not_found", status_code=404)

    active_items = manager.list_provider_instances("imessage", active_only=True)
    if not active_items:
        return None
    if len(active_items) == 1:
        return active_items[0]
    raise GatewayManagerError("ambiguous_imessage_instance", status_code=409)


async def resume_after_approval(
    manager: GatewayManager,
    *,
    target_instance: dict[str, Any] | None,
    event_payload: dict[str, Any],
    approval_ids: list[str] | None = None,
) -> dict[str, Any]:
    chat_id = str(event_payload.get("chat_id") or event_payload.get("handle") or "").strip()
    bot_id = str(event_payload.get("bot_id") or "").strip()
    instance_id = str(event_payload.get("instance_id") or (target_instance or {}).get("id") or "").strip()
    if not chat_id or not instance_id:
        return {"resumed": False, "reason": "missing_chat_or_instance_id"}

    gateway_key = manager.gateway_context._gateway_key(
        provider="imessage",
        instance_id=instance_id,
        chat_id=chat_id,
    )  # noqa: SLF001
    conversation = await manager.gateway_context.store.aget_or_create_conversation(
        provider="imessage",
        gateway_key=gateway_key,
        instance_id=instance_id,
        bot_id=bot_id,
        chat_id=chat_id,
    )
    matched_runs = await manager.gateway_context.find_executions_for_approval_ids(
        approval_ids=approval_ids or [],
        conversation_id=conversation["id"],
        statuses=["awaiting_approval"],
    )
    if not matched_runs:
        return {"resumed": False, "reason": "no_execution_bound_to_approval", "conversation_id": conversation["id"]}

    async def _imessage_result_sender(reply_text: str, ctx: dict[str, Any]) -> bool:
        notifier = manager.build_imessage_notifier(target_instance)
        if not notifier:
            return False
        target_handle = str(ctx.get("chat_id") or "").strip() or chat_id
        sent = await notifier.send_notify_payload(
            {
                "content": reply_text,
                "chat_id": target_handle,
                "files": ctx.get("files") if isinstance(ctx, dict) else [],
            }
        )
        if sent:
            metadata = notifier.last_delivery_metadata() if hasattr(notifier, "last_delivery_metadata") else {}
            await manager.gateway_context.bind_anchor_delivery(
                anchor_id=str(ctx.get("anchor_id") or "").strip() or None,
                channel_message_id=str(metadata.get("channel_message_id") or "").strip() or None,
                channel_thread_id=str(metadata.get("channel_thread_id") or "").strip() or None,
            )
        return sent

    resumed: list[dict[str, Any]] = []
    agent = manager._gateway_agent_id(
        "imessage",
        target_instance,
        event_payload={
            "instance_id": instance_id,
            "chat_id": chat_id,
            "bot_id": bot_id,
        },
    )  # noqa: SLF001
    seen_execution_ids: set[str] = set()
    for run in matched_runs:
        execution_id = str(run.get("id") or "").strip()
        if not execution_id or execution_id in seen_execution_ids:
            continue
        seen_execution_ids.add(execution_id)
        item = await manager.gateway_context.resume_execution(
            provider="imessage",
            execution_id=execution_id,
            chat_id=chat_id,
            agent_id=agent,
            on_result=_imessage_result_sender,
        )
        if item.get("resumed"):
            resumed.append(item)
    if not resumed:
        return {"resumed": False, "reason": "resume_execution_failed", "conversation_id": conversation["id"]}
    return {
        "resumed": True,
        "conversation_id": conversation["id"],
        "execution_ids": [item.get("task_run_id") for item in resumed],
        "runtime_session_ids": [item.get("runtime_session_id") for item in resumed],
        "agent_id": agent,
    }


async def handle_approval_followup(
    manager: GatewayManager,
    *,
    target_instance: dict[str, Any] | None,
    event_payload: dict[str, Any],
    approval_command: dict[str, Any],
) -> dict[str, Any] | None:
    handle_for_notice = str(event_payload.get("chat_id") or event_payload.get("handle") or "").strip() or None
    if handle_for_notice:
        notifier = manager.build_imessage_notifier(target_instance)
        if notifier:
            try:
                resolved_count = int(approval_command.get("resolved_count") or 0)
                status = str(approval_command.get("status") or "")
                if resolved_count > 0 and status:
                    notice = format_approval_notice(status=status, resolved_count=resolved_count)
                    await notifier.send_message(text=notice, handle=handle_for_notice)
            except Exception:
                logger.warning(
                    "[iMessage] 审批通知发送失败 handle=%s",
                    handle_for_notice,
                    exc_info=True,
                )

    if (
        approval_command.get("resolved")
        and str(approval_command.get("status") or "") == "approved"
        and any(str(item or "").strip() for item in (approval_command.get("approval_ids") or []))
    ):
        return await resume_after_approval(
            manager,
            target_instance=target_instance,
            event_payload=event_payload,
            approval_ids=[str(item) for item in (approval_command.get("approval_ids") or []) if str(item or "").strip()],
        )
    return None
