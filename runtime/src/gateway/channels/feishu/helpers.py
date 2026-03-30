from __future__ import annotations

from collections.abc import Mapping
from typing import TYPE_CHECKING, Any

import logging

from src.gateway.channels.shared import format_approval_notice, query_value

if TYPE_CHECKING:
    from src.gateway.manager import GatewayManager

logger = logging.getLogger(__name__)


def _query_value(query_params: Mapping[str, str] | None, *keys: str) -> str | None:
    return query_value(query_params, *keys)


def resolve_instance_for_ingest(
    manager: GatewayManager,
    payload: dict[str, Any],
    query_params: Mapping[str, str] | None,
) -> dict[str, Any] | None:
    from src.gateway.manager import GatewayManagerError

    instance_id = _query_value(query_params, "instanceId", "instance_id")
    if instance_id:
        item = manager._get_instance(instance_id)  # noqa: SLF001
        if item and str(item.get("provider")) == "feishu":
            return item
        raise GatewayManagerError("gateway_instance_not_found", status_code=404)

    active_items = manager.list_provider_instances("feishu", active_only=True)
    if not active_items:
        return None

    token_in_payload = ""
    header = payload.get("header")
    if isinstance(header, dict):
        token_in_payload = str(header.get("token") or "").strip()
    if not token_in_payload:
        token_in_payload = str(payload.get("token") or "").strip()

    matched: list[dict[str, Any]] = []
    if token_in_payload:
        for item in active_items:
            cfg = item.get("config")
            cfg_map = cfg if isinstance(cfg, dict) else {}
            verify_token = str(cfg_map.get("verifyToken") or "").strip()
            if verify_token and verify_token == token_in_payload:
                matched.append(item)
        if len(matched) == 1:
            return matched[0]
        if len(matched) > 1:
            raise GatewayManagerError("ambiguous_feishu_instance", status_code=409)

    if len(active_items) == 1:
        return active_items[0]
    return None


async def resume_after_approval(
    manager: GatewayManager,
    *,
    target_instance: dict[str, Any] | None,
    event_payload: dict[str, Any],
    approval_ids: list[str] | None = None,
) -> dict[str, Any]:
    chat_id = str(event_payload.get("chat_id") or "").strip()
    explicit_instance_id = str(event_payload.get("instance_id") or "").strip()
    instance_id = explicit_instance_id or str((target_instance or {}).get("id") or "").strip()

    matched_runs: list[dict[str, Any]] = []
    if approval_ids:
        matched_runs = await manager.gateway_context.find_executions_for_approval_ids(
            approval_ids=approval_ids,
            conversation_id=None,
            statuses=["awaiting_approval"],
        )

    if matched_runs:
        conversation = await manager.gateway_context.store.aget_conversation(
            str(matched_runs[0].get("conversation_id") or "").strip()
        )
        if conversation:
            chat_id = str(conversation.get("chat_id") or "").strip() or chat_id
            instance_id = str(conversation.get("instance_id") or "").strip() or instance_id

    if not chat_id or not instance_id:
        return {"resumed": False, "reason": "missing_chat_or_instance_id"}

    gateway_key = manager.gateway_context._gateway_key(
        provider="feishu",
        instance_id=instance_id,
        chat_id=chat_id,
    )  # noqa: SLF001
    conversation = await manager.gateway_context.store.aget_or_create_conversation(
        provider="feishu",
        gateway_key=gateway_key,
        instance_id=instance_id,
        bot_id=str((target_instance or {}).get("id") or "").strip() or "feishu-app",
        chat_id=chat_id,
    )
    matched_runs = await manager.gateway_context.find_executions_for_approval_ids(
        approval_ids=approval_ids or [],
        conversation_id=conversation["id"],
        statuses=["awaiting_approval"],
    )
    if not matched_runs:
        return {"resumed": False, "reason": "no_execution_bound_to_approval", "conversation_id": conversation["id"]}

    notifier = manager.build_feishu_notifier(target_instance)

    async def _feishu_result_sender(reply_text: str, context: dict[str, Any]) -> bool:
        if not notifier:
            return False
        context_map = context if isinstance(context, dict) else {}
        files = context_map.get("files")
        target_chat_id = str(context_map.get("chat_id") or chat_id).strip()
        sent = await notifier.send_notify_payload(
            {
                "title": "Semibot",
                "content": reply_text,
                "channel": target_chat_id or "default",
                "receive_id_type": "chat_id" if target_chat_id else None,
                "receive_id": target_chat_id or None,
                "files": files if isinstance(files, list) else [],
            }
        )
        if sent:
            metadata = notifier.last_delivery_metadata() if hasattr(notifier, "last_delivery_metadata") else {}
            await manager.gateway_context.bind_anchor_delivery(
                anchor_id=str(context_map.get("anchor_id") or "").strip() or None,
                channel_message_id=str(metadata.get("channel_message_id") or "").strip() or None,
                channel_thread_id=str(metadata.get("channel_thread_id") or "").strip() or None,
            )
        return sent

    resumed: list[dict[str, Any]] = []
    seen_execution_ids: set[str] = set()
    agent_id = manager._gateway_agent_id(
        "feishu",
        target_instance,
        event_payload={"chat_id": chat_id, "instance_id": instance_id},
    )  # noqa: SLF001
    for run in matched_runs:
        execution_id = str(run.get("id") or "").strip()
        if not execution_id or execution_id in seen_execution_ids:
            continue
        seen_execution_ids.add(execution_id)
        item = await manager.gateway_context.resume_execution(
            provider="feishu",
            execution_id=execution_id,
            chat_id=chat_id,
            agent_id=agent_id,
            on_result=_feishu_result_sender,
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
        "agent_id": agent_id,
    }


async def handle_approval_followup(
    manager: GatewayManager,
    *,
    target_instance: dict[str, Any] | None,
    event_payload: dict[str, Any],
    approval_command: dict[str, Any],
) -> dict[str, Any] | None:
    chat_id_for_notice = str(event_payload.get("chat_id") or "").strip() or None
    if chat_id_for_notice:
        notifier = manager.build_feishu_notifier(target_instance)
        if notifier:
            try:
                resolved_count = int(approval_command.get("resolved_count") or 0)
                status = str(approval_command.get("status") or "")
                if resolved_count > 0 and status:
                    notice = format_approval_notice(status=status, resolved_count=resolved_count)
                    await notifier.send_notify_payload(
                        {
                            "title": "Semibot",
                            "content": notice,
                            "channel": chat_id_for_notice,
                            "receive_id_type": "chat_id",
                            "receive_id": chat_id_for_notice,
                        }
                    )
            except Exception:
                logger.warning("[Feishu] 审批通知发送失败 chat_id=%s", chat_id_for_notice, exc_info=True)

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
