from __future__ import annotations

import logging
from collections.abc import Mapping
from datetime import UTC, datetime
from pathlib import Path
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
    headers: Mapping[str, str] | None,
    query_params: Mapping[str, str] | None,
) -> dict[str, Any] | None:
    from src.gateway.manager import GatewayManagerError

    instance_id = (
        _query_value(query_params, "instanceId", "instance_id")
        or (str(headers.get("x-semibot-instance-id", "")).strip() if headers else "")
        or None
    )
    if instance_id:
        item = manager._get_instance(instance_id)  # noqa: SLF001
        if item and str(item.get("provider")) == "telegram":
            return item
        raise GatewayManagerError("gateway_instance_not_found", status_code=404)

    active_items = manager.list_provider_instances("telegram", active_only=True)
    if not active_items:
        return None

    secret = str(headers.get("x-telegram-bot-api-secret-token", "")).strip() if headers else ""
    if secret:
        matched: list[dict[str, Any]] = []
        for item in active_items:
            cfg = item.get("config")
            cfg_map = cfg if isinstance(cfg, dict) else {}
            webhook_secret = str(cfg_map.get("webhookSecret") or "").strip()
            if webhook_secret and webhook_secret == secret:
                matched.append(item)
        if len(matched) == 1:
            return matched[0]
        if len(matched) > 1:
            raise GatewayManagerError("ambiguous_telegram_instance", status_code=409)

    if len(active_items) == 1:
        return active_items[0]
    raise GatewayManagerError("ambiguous_telegram_instance", status_code=409)


async def download_attachments(
    manager: GatewayManager,
    *,
    token: str,
    chat_id: str,
    message_id: Any,
    attachments: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    if not attachments:
        return []
    max_bytes = manager._telegram_inbound_max_bytes()  # noqa: SLF001
    date_path = datetime.now(UTC).strftime("%Y%m%d")
    root = manager._telegram_inbound_root_dir() / manager._sanitize_path_component(chat_id) / date_path  # noqa: SLF001
    root.mkdir(parents=True, exist_ok=True)

    results: list[dict[str, Any]] = []
    for idx, item in enumerate(attachments):
        file_id = str(item.get("file_id") or "").strip()
        if not file_id:
            continue
        expected_size = item.get("file_size")
        if isinstance(expected_size, int) and expected_size > max_bytes:
            results.append({**item, "status": "skipped", "reason": f"file_too_large:{expected_size}>{max_bytes}"})
            continue
        try:
            file_path = await manager._telegram_get_file_path(token=token, file_id=file_id)  # noqa: SLF001
            guessed_name = Path(file_path).name
            fallback_ext = manager._guess_extension(str(item.get("mime_type") or ""), fallback=".bin")  # noqa: SLF001
            fallback_name = f"telegram_{message_id}_{idx + 1}{fallback_ext}"
            safe_name = manager._safe_filename(  # noqa: SLF001
                str(item.get("file_name") or guessed_name),
                fallback=fallback_name,
            )
            content = await manager._telegram_download_content(token=token, file_path=file_path)  # noqa: SLF001
            if len(content) > max_bytes:
                results.append(
                    {
                        **item,
                        "status": "skipped",
                        "reason": f"downloaded_file_too_large:{len(content)}>{max_bytes}",
                        "telegram_file_path": file_path,
                    }
                )
                continue
            ts = datetime.now(UTC).strftime("%H%M%S")
            dest = root / f"{ts}_{idx + 1}_{safe_name}"
            dest.write_bytes(content)
            results.append(
                {
                    **item,
                    "status": "downloaded",
                    "telegram_file_path": file_path,
                    "local_path": str(dest.resolve()),
                    "stored_size": len(content),
                }
            )
        except Exception as exc:  # noqa: BLE001
            results.append({**item, "status": "error", "reason": str(exc)})
    return results


async def resume_after_approval(
    manager: GatewayManager,
    *,
    target_instance: dict[str, Any] | None,
    token: str,
    event_payload: dict[str, Any],
    approval_ids: list[str] | None = None,
) -> dict[str, Any]:
    chat_id = str(event_payload.get("chat_id") or "").strip()
    bot_id = str(event_payload.get("bot_id") or "").strip() or str(manager._telegram_bot_id(token) or "").strip()  # noqa: SLF001
    instance_id = str(event_payload.get("instance_id") or (target_instance or {}).get("id") or "").strip()
    if not chat_id or not instance_id:
        return {"resumed": False, "reason": "missing_chat_or_instance_id"}

    gateway_key = manager.gateway_context._gateway_key(
        provider="telegram",
        instance_id=instance_id,
        chat_id=chat_id,
    )  # noqa: SLF001
    conversation = await manager.gateway_context.store.aget_or_create_conversation(
        provider="telegram",
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

    async def _telegram_result_sender(reply_text: str, ctx: dict[str, Any]) -> bool:
        notifier = manager.build_telegram_notifier(target_instance)
        if not notifier:
            return False
        target_chat_id = str(ctx.get("chat_id") or "").strip() or chat_id
        sent = await notifier.send_notify_payload(
            {
                "content": reply_text,
                "chat_id": target_chat_id,
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
        "telegram",
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
            provider="telegram",
            execution_id=execution_id,
            chat_id=chat_id,
            agent_id=agent,
            on_result=_telegram_result_sender,
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
    token: str,
    event_payload: dict[str, Any],
    approval_command: dict[str, Any],
) -> dict[str, Any] | None:
    chat_id_for_notice = str(event_payload.get("chat_id") or "").strip() or None
    if chat_id_for_notice:
        notifier = manager.build_telegram_notifier(target_instance)
        if notifier:
            try:
                resolved_count = int(approval_command.get("resolved_count") or 0)
                status = str(approval_command.get("status") or "")
                if resolved_count > 0 and status:
                    notice = format_approval_notice(status=status, resolved_count=resolved_count)
                    await notifier.send_message(text=notice, chat_id=chat_id_for_notice)
            except Exception:
                logger.warning(
                    "[Telegram] 审批通知发送失败 chat_id=%s",
                    chat_id_for_notice,
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
            token=token,
            event_payload=event_payload,
            approval_ids=[str(item) for item in (approval_command.get("approval_ids") or []) if str(item or "").strip()],
        )
    return None
