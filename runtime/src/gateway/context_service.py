"""Unified Gateway Context Service (GCS).

This service keeps gateway-level main context stable and runs runtime tasks in
isolated runtime sessions, then appends minimal result back to gateway context.
"""

from __future__ import annotations

import asyncio
from contextlib import suppress
import logging
import os
from pathlib import Path
import shutil
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import uuid4

from src.events.event_store import EventStore
from src.gateway.policies.addressing import AddressingDecision, decide_addressing
from src.gateway.store.gateway_store import GatewayStore
from src.server.cli_import_service import create_cli_import_request
from src.server.config_store import RuntimeConfigStore
from src.skills.bootstrap import create_default_registry
from src.constants.config import (
    GATEWAY_APPROVAL_LIST_LIMIT,
    GATEWAY_APPROVAL_POLL_INTERVAL_SECONDS,
    GATEWAY_PLAN_PREVIEW_MAX_STEPS,
    GATEWAY_TASK_TIMEOUT_SECONDS,
)

logger = logging.getLogger(__name__)

TaskRunner = Callable[..., Awaitable[dict[str, Any]]]
ReplySender = Callable[[str, dict[str, Any]], Awaitable[bool]]


class GatewayContextService:
    def __init__(
        self,
        *,
        db_path: str,
        config_store: RuntimeConfigStore,
        task_runner: TaskRunner,
        runtime_db_path: str,
        rules_path: str,
    ):
        self.store = GatewayStore(db_path=db_path)
        self.event_store = EventStore(db_path=runtime_db_path)
        self.config_store = config_store
        self.task_runner = task_runner
        self.runtime_db_path = runtime_db_path
        self.rules_path = rules_path
        timeout_raw = str(os.getenv("SEMIBOT_GATEWAY_TASK_TIMEOUT_SEC", str(GATEWAY_TASK_TIMEOUT_SECONDS))).strip()
        self.task_timeout_seconds = int(timeout_raw) if timeout_raw.isdigit() and int(timeout_raw) > 0 else GATEWAY_TASK_TIMEOUT_SECONDS

    @staticmethod
    def _session_busy(status: str | None) -> bool:
        return str(status or "").strip().lower() in {"queued", "running", "awaiting_approval"}

    @staticmethod
    def _session_reusable(status: str | None) -> bool:
        normalized = str(status or "").strip().lower()
        return normalized in {"idle", "done", "completed", "received", "planning", ""}

    @staticmethod
    def _session_checkpoint_root() -> Path:
        root = Path(str(Path.home() / ".semibot" / "sessions")).expanduser().resolve()
        root.mkdir(parents=True, exist_ok=True)
        return root

    @staticmethod
    def _workspace_root() -> Path:
        root = Path(str(Path.home() / ".semibot" / "workspaces")).expanduser().resolve()
        root.mkdir(parents=True, exist_ok=True)
        return root

    @staticmethod
    def _extract_tool_usage_events(runtime_result: dict[str, Any], *, task_run_id: str) -> list[dict[str, Any]]:
        rows = runtime_result.get("tool_results") if isinstance(runtime_result.get("tool_results"), list) else []
        events: list[dict[str, Any]] = []
        for row in rows:
            if not isinstance(row, dict):
                continue
            metadata = row.get("metadata") if isinstance(row.get("metadata"), dict) else {}
            tool_id = str(metadata.get("tool_id") or "").strip()
            tool_name = str(row.get("tool_name") or "").strip()
            actual_tool_name = str(metadata.get("actual_tool_name") or tool_name).strip()
            if not tool_id or not tool_name:
                continue
            events.append(
                {
                    "task_run_id": task_run_id,
                    "tool_id": tool_id,
                    "tool_name": tool_name,
                    "actual_tool_name": actual_tool_name or tool_name,
                    "source_type": str(metadata.get("source") or metadata.get("source_type") or "builtin").strip() or "builtin",
                    "success": bool(row.get("success")),
                    "metadata": {
                        "duration_ms": int(row.get("duration_ms") or 0) if isinstance(row.get("duration_ms"), (int, float)) else 0,
                        "error": str(row.get("error") or "").strip() or None,
                    },
                }
            )
        return events

    def _fork_runtime_session(self, *, provider: str, source_session_id: str | None) -> str:
        new_session_id = f"sess_{provider}_{uuid4().hex[:12]}"
        source_id = str(source_session_id or "").strip()
        if not source_id:
            return new_session_id

        checkpoint_root = self._session_checkpoint_root()
        workspace_root = self._workspace_root()
        source_session_root = checkpoint_root / source_id
        target_session_root = checkpoint_root / new_session_id
        source_workspace_root = workspace_root / source_id
        target_workspace_root = workspace_root / new_session_id

        try:
            if source_session_root.exists():
                shutil.copytree(source_session_root, target_session_root, dirs_exist_ok=True)
                source_memory_file = target_session_root / "memory" / f"{source_id}.md"
                if source_memory_file.exists():
                    target_memory_file = source_memory_file.with_name(f"{new_session_id}.md")
                    target_memory_file.write_text(source_memory_file.read_text(encoding="utf-8"), encoding="utf-8")
                    source_memory_file.unlink(missing_ok=True)
            if source_workspace_root.exists():
                shutil.copytree(source_workspace_root, target_workspace_root, dirs_exist_ok=True)
        except Exception:
            # Best-effort fork: fall back to a clean runtime session if snapshot copy fails.
            with suppress(Exception):
                if target_session_root.exists():
                    shutil.rmtree(target_session_root, ignore_errors=True)
            with suppress(Exception):
                if target_workspace_root.exists():
                    shutil.rmtree(target_workspace_root, ignore_errors=True)
        return new_session_id

    async def _resolve_runtime_session_for_execution(
        self,
        *,
        provider: str,
        conversation: dict[str, Any],
    ) -> tuple[str, str | None]:
        mounted_session_id = str(conversation.get("active_runtime_session_id") or "").strip()
        mounted_status = str(conversation.get("active_runtime_session_status") or "idle").strip().lower()

        if not mounted_session_id:
            created = f"sess_{provider}_{uuid4().hex[:12]}"
            await self.store.aset_active_runtime_session(
                conversation["id"],
                runtime_session_id=created,
                status="queued",
                forked_from_session_id=None,
            )
            return created, None

        if self._session_busy(mounted_status):
            forked = self._fork_runtime_session(provider=provider, source_session_id=mounted_session_id)
            await self.store.aset_active_runtime_session(
                conversation["id"],
                runtime_session_id=forked,
                status="queued",
                forked_from_session_id=mounted_session_id,
            )
            return forked, mounted_session_id

        if self._session_reusable(mounted_status):
            await self.store.aset_active_runtime_session(
                conversation["id"],
                runtime_session_id=mounted_session_id,
                status="queued",
                forked_from_session_id=str(conversation.get("active_runtime_forked_from_session_id") or "").strip() or None,
            )
            return mounted_session_id, None

        created = f"sess_{provider}_{uuid4().hex[:12]}"
        await self.store.aset_active_runtime_session(
            conversation["id"],
            runtime_session_id=created,
            status="queued",
            forked_from_session_id=None,
        )
        return created, None

    async def _should_send_immediate_ack(self, provider: str) -> bool:
        cfg = await self._provider_config(provider)
        raw = cfg.get("sendImmediateAck")
        if raw is None:
            raw = cfg.get("send_immediate_ack")
        if raw is None:
            return True
        if isinstance(raw, bool):
            return raw
        text = str(raw).strip().lower()
        if text in {"1", "true", "yes", "on"}:
            return True
        if text in {"0", "false", "no", "off"}:
            return False
        return bool(raw)

    @staticmethod
    def _format_immediate_ack_message() -> str:
        return "已收到，正在处理。"

    async def _agent_runtime_config(self, agent_id: str) -> dict[str, str | None]:
        safe_agent_id = str(agent_id or "").strip()
        if not safe_agent_id:
            return {
                "model": None,
                "model_provider_key": None,
                "fallback_model": None,
                "fallback_provider_key": None,
                "system_prompt": None,
            }

        profile = await self.config_store.aget_agent_profile(safe_agent_id) or {}
        metadata = profile.get("metadata")
        metadata_map = metadata if isinstance(metadata, dict) else {}
        config = metadata_map.get("config")
        config_map = config if isinstance(config, dict) else {}

        def _clean(value: Any) -> str | None:
            text = str(value or "").strip()
            return text or None

        return {
            "model": _clean(profile.get("model")),
            "model_provider_key": _clean(
                config_map.get("modelProviderKey") or config_map.get("model_provider_key")
            ),
            "fallback_model": _clean(
                config_map.get("fallbackModel") or config_map.get("fallback_model")
            ),
            "fallback_provider_key": _clean(
                config_map.get("fallbackProviderKey") or config_map.get("fallback_provider_key")
            ),
            "system_prompt": _clean(
                profile.get("system_prompt")
                or config_map.get("systemPrompt")
                or config_map.get("system_prompt")
            ),
        }

    async def _provider_config(self, provider: str) -> dict[str, Any]:
        item = await self.config_store.aget_gateway_config(provider) or {}
        cfg = item.get("config")
        return cfg if isinstance(cfg, dict) else {}

    async def _addressing_policy(self, provider: str) -> dict[str, Any]:
        cfg = await self._provider_config(provider)
        policy = cfg.get("addressingPolicy")
        if isinstance(policy, dict):
            return policy
        default_mode = "all_messages" if provider in {"telegram", "whatsapp", "imessage"} else "mention_only"
        return {
            "mode": default_mode,
            "allowReplyToBot": True,
            "executeOnUnaddressed": False,
            "commandPrefixes": ["/ask", "/run", "/approve", "/reject"],
            "sessionContinuationWindowSec": 300,
        }

    def _gateway_key(self, *, provider: str, instance_id: str, chat_id: str) -> str:
        return f"{provider}:{instance_id}:{chat_id}"

    @staticmethod
    def _normalized_attachments(value: Any) -> list[dict[str, Any]]:
        if not isinstance(value, list):
            return []
        items: list[dict[str, Any]] = []
        for raw in value:
            if not isinstance(raw, dict):
                continue
            item = dict(raw)
            local_path = str(item.get("local_path") or "").strip()
            if local_path:
                items.append(item)
        return items

    @staticmethod
    def _build_task_input(
        *,
        text: str,
        attachments: list[dict[str, Any]],
        gateway_id: str | None = None,
        provider: str | None = None,
        instance_id: str | None = None,
        bot_id: str | None = None,
        chat_id: str | None = None,
    ) -> str:
        context_lines: list[str] = []
        if gateway_id:
            context_lines.extend(
                [
                    "【Gateway Context】",
                    f"gateway_id={gateway_id}",
                    f"provider={provider or ''}",
                    f"instance_id={instance_id or ''}",
                    f"bot_id={bot_id or ''}",
                    f"chat_id={chat_id or ''}",
                    "When creating cron rules with notify action, set actions[].params.gateway_id to this gateway_id.",
                    "",
                ]
            )

        if not attachments:
            if context_lines:
                return "\n".join(context_lines + [text])
            return text
        lead = text.strip() or f"用户上传了 {len(attachments)} 个文件，请先阅读附件后再完成任务。"
        lines = context_lines + [lead, "", "【用户上传附件】"]
        for idx, item in enumerate(attachments, start=1):
            name = str(item.get("file_name") or item.get("name") or f"attachment_{idx}").strip()
            local_path = str(item.get("local_path") or "").strip()
            mime = str(item.get("mime_type") or "").strip()
            size = item.get("stored_size")
            detail_parts = [f"path={local_path}"]
            if mime:
                detail_parts.append(f"mime={mime}")
            if isinstance(size, int) and size > 0:
                detail_parts.append(f"size={size}")
            lines.append(f"{idx}. {name} ({', '.join(detail_parts)})")
        return "\n".join(lines)

    @staticmethod
    def _format_plan_preview_message(steps: list[dict[str, Any]]) -> str:
        if not steps:
            return "已收到任务，正在开始执行。"
        top = steps[:GATEWAY_PLAN_PREVIEW_MAX_STEPS]
        lines = ["已收到任务，先给您执行计划：", ""]
        for idx, step in enumerate(top, start=1):
            title = str(step.get("title") or step.get("id") or f"步骤{idx}").strip()
            tool = str(step.get("tool") or "").strip()
            if tool:
                lines.append(f"{idx}. {title}（{tool}）")
            else:
                lines.append(f"{idx}. {title}")
        if len(steps) > len(top):
            lines.append(f"... 共 {len(steps)} 步")
        lines.extend(["", "我会按这个计划继续执行，完成后回复结果。"])
        return "\n".join(lines)

    @staticmethod
    def _extract_generated_files(runtime_result: dict[str, Any]) -> list[dict[str, Any]]:
        rows = runtime_result.get("tool_results")
        if not isinstance(rows, list):
            return []
        files: list[dict[str, Any]] = []
        seen: set[str] = set()
        for row in rows:
            if not isinstance(row, dict):
                continue
            metadata = row.get("metadata")
            meta = metadata if isinstance(metadata, dict) else {}
            generated = meta.get("generated_files")
            items = generated if isinstance(generated, list) else []
            for item in items:
                if not isinstance(item, dict):
                    continue
                path = str(item.get("path") or item.get("local_path") or "").strip()
                if not path or path in seen:
                    continue
                seen.add(path)
                files.append(
                    {
                        "local_path": path,
                        "filename": str(item.get("filename") or "").strip(),
                        "mime_type": str(item.get("mime_type") or "").strip(),
                        "size": item.get("size"),
                        "file_id": item.get("file_id"),
                    }
                )
        return files

    @staticmethod
    def _extract_pending_approval_ids(runtime_result: dict[str, Any]) -> list[str]:
        ids: list[str] = []
        seen: set[str] = set()

        top_level_ids = runtime_result.get("pending_approval_ids")
        if isinstance(top_level_ids, list):
            for item in top_level_ids:
                approval_id = str(item or "").strip()
                if approval_id and approval_id not in seen:
                    seen.add(approval_id)
                    ids.append(approval_id)

        runtime_events = runtime_result.get("runtime_events")
        if isinstance(runtime_events, list):
            for event in runtime_events:
                if not isinstance(event, dict):
                    continue
                event_name = str(event.get("event") or "").strip()
                if event_name != "approval.requested":
                    continue
                data = event.get("data")
                approval_id = ""
                if isinstance(data, dict):
                    approval_id = str(data.get("approval_id") or "").strip()
                if approval_id and approval_id not in seen:
                    seen.add(approval_id)
                    ids.append(approval_id)

        tool_results = runtime_result.get("tool_results")
        if isinstance(tool_results, list):
            for item in tool_results:
                if not isinstance(item, dict):
                    continue
                metadata = item.get("metadata")
                approval_id = ""
                if isinstance(metadata, dict):
                    approval_id = str(metadata.get("approval_id") or "").strip()
                if approval_id and approval_id not in seen:
                    seen.add(approval_id)
                    ids.append(approval_id)
        return ids

    @staticmethod
    def _extract_missing_capability(runtime_result: dict[str, Any]) -> dict[str, Any] | None:
        tool_results = runtime_result.get("tool_results")
        if not isinstance(tool_results, list):
            return None
        for item in tool_results:
            if not isinstance(item, dict):
                continue
            metadata = item.get("metadata")
            if not isinstance(metadata, dict):
                continue
            missing = metadata.get("missing_capability")
            if isinstance(missing, dict) and str(missing.get("intent") or "").strip():
                return dict(missing)
        return None

    @staticmethod
    def _extract_proposed_cli_import(runtime_result: dict[str, Any]) -> dict[str, Any] | None:
        tool_results = runtime_result.get("tool_results")
        if not isinstance(tool_results, list):
            return None
        for item in tool_results:
            if not isinstance(item, dict):
                continue
            metadata = item.get("metadata")
            if not isinstance(metadata, dict):
                continue
            proposed = metadata.get("proposed_cli_import")
            if not isinstance(proposed, dict):
                continue
            command = proposed.get("command")
            shape = str(proposed.get("shape") or "").strip().lower()
            if shape in {"direct", "group"} and isinstance(command, list) and any(str(part or "").strip() for part in command):
                return dict(proposed)
        return None

    @staticmethod
    def _append_approval_hints(final_response: str, approval_ids: list[str]) -> str:
        if not approval_ids:
            return final_response
        content = final_response.strip()
        if content and all(approval_id in content for approval_id in approval_ids):
            return final_response
        hint = (
            f"\n\n发现待审批操作：{', '.join(approval_ids)}。"
            "\n可直接回复“同意”（一次通过当前会话全部待审批），"
            "或按 ID 执行 /approve <id> /reject <id>。"
        )
        if content:
            return f"{final_response}{hint}"
        return f"操作需要人工审批。{hint}"

    @classmethod
    def _resolve_awaiting_approval_notice(
        cls,
        *,
        runtime_result: dict[str, Any] | None = None,
        approval_ids: list[str],
        fallback_message: str,
    ) -> str:
        result = runtime_result if isinstance(runtime_result, dict) else {}
        explicit = str(result.get("awaiting_approval_message") or "").strip()
        if explicit:
            return cls._append_approval_hints(explicit, approval_ids)
        return cls._append_approval_hints(fallback_message, approval_ids)

    @staticmethod
    def _append_cli_import_hint(final_response: str, request_id: str) -> str:
        request_id = str(request_id or "").strip()
        if not request_id:
            return final_response
        content = final_response.strip()
        if request_id in content:
            return final_response
        hint = (
            f"\n\n系统已生成 CLI 导入审批请求：{request_id}。"
            "\n请在工具中心批准后重试，或使用 `semibot tools approve-import "
            f"{request_id}` 通过该请求。"
        )
        return f"{final_response}{hint}" if content else f"需要批准新的 CLI 工具导入。{hint}"

    async def _pending_approval_ids_for_session(self, session_id: str) -> list[str]:
        approvals = await asyncio.to_thread(self.event_store.list_approvals, status="pending", limit=GATEWAY_APPROVAL_LIST_LIMIT)
        ids: list[str] = []
        for item in approvals:
            context = item.context if isinstance(getattr(item, "context", None), dict) else {}
            if str(context.get("session_id") or "").strip() != session_id:
                continue
            approval_id = str(getattr(item, "approval_id", "") or "").strip()
            if approval_id:
                ids.append(approval_id)
        return ids

    async def _conversation_identity(self, provider: str, payload: dict[str, Any]) -> tuple[str, str, str]:
        chat_id = str(payload.get("chat_id") or payload.get("subject") or "").strip()
        if not chat_id:
            chat_id = "unknown"

        instance_id = str(payload.get("instance_id") or payload.get("gateway_instance_id") or "").strip()
        if not instance_id:
            instance_id = provider

        if provider == "telegram":
            bot_id = str(payload.get("bot_id") or (await self._provider_config("telegram")).get("botId") or "telegram-bot").strip()
        elif provider == "discord":
            bot_id = str(payload.get("bot_id") or (await self._provider_config("discord")).get("botUserId") or "discord-bot").strip()
        elif provider == "whatsapp":
            bot_id = str(payload.get("bot_id") or (await self._provider_config("whatsapp")).get("sessionName") or "whatsapp-bot").strip()
        elif provider == "imessage":
            bot_id = str(payload.get("bot_id") or (await self._provider_config("imessage")).get("bridgeId") or "imessage-bot").strip()
        else:
            feishu_cfg = await self._provider_config("feishu")
            bot_id = str(payload.get("app_id") or feishu_cfg.get("appId") or "feishu-app").strip()
        if not bot_id:
            bot_id = "unknown-bot"
        return instance_id, bot_id, chat_id

    async def _continuation_hit(self, conversation_id: str, policy: dict[str, Any]) -> bool:
        window = int(policy.get("sessionContinuationWindowSec") or 0)
        if window <= 0:
            return False
        last_assistant_at = await self.store.alatest_assistant_at(conversation_id)
        if not last_assistant_at:
            return False
        try:
            last_dt = datetime.fromisoformat(last_assistant_at)
        except Exception:
            return False
        now = datetime.now(UTC)
        if last_dt.tzinfo is None:
            last_dt = last_dt.replace(tzinfo=UTC)
        return last_dt >= now - timedelta(seconds=window)

    async def should_execute(
        self,
        *,
        provider: str,
        conversation_id: str,
        text: str,
        is_mention: bool,
        is_reply_to_bot: bool,
        chat_type: str | None = None,
        force_execute: bool = False,
    ) -> AddressingDecision:
        if force_execute:
            return AddressingDecision(addressed=True, should_execute=True, reason="forced")
        # In Feishu p2p (single chat), treat user message as addressed by default.
        # This avoids requiring explicit @mention in direct conversations.
        if provider == "feishu" and str(chat_type or "").strip().lower() == "p2p":
            return AddressingDecision(addressed=True, should_execute=True, reason="feishu_p2p")
        if provider == "discord" and str(chat_type or "").strip().lower() == "dm":
            return AddressingDecision(addressed=True, should_execute=True, reason="discord_dm")
        if provider in {"whatsapp", "imessage"} and str(chat_type or "").strip().lower() in {"dm", "p2p", "direct"}:
            return AddressingDecision(addressed=True, should_execute=True, reason=f"{provider}_direct")
        policy = await self._addressing_policy(provider)
        continuation_hit = await self._continuation_hit(conversation_id, policy)
        return decide_addressing(
            text=text,
            is_mention=is_mention,
            is_reply_to_bot=is_reply_to_bot,
            policy=policy,
            continuation_hit=continuation_hit,
        )

    async def ingest_message(
        self,
        *,
        provider: str,
        event_payload: dict[str, Any],
        source: str,
        subject: str | None,
        text: str,
        agent_id: str = "semibot",
        force_execute: bool = False,
        on_result: ReplySender | None = None,
    ) -> dict[str, Any]:
        instance_id, bot_id, chat_id = await self._conversation_identity(provider, event_payload)
        gateway_key = self._gateway_key(provider=provider, instance_id=instance_id, chat_id=chat_id)
        conversation = await self.store.aget_or_create_conversation(
            provider=provider,
            gateway_key=gateway_key,
            instance_id=instance_id,
            bot_id=bot_id,
            chat_id=chat_id,
        )

        decision = await self.should_execute(
            provider=provider,
            conversation_id=conversation["id"],
            text=text,
            is_mention=bool(event_payload.get("is_mention")),
            is_reply_to_bot=bool(event_payload.get("is_reply_to_bot")),
            chat_type=str(event_payload.get("chat_type") or ""),
            force_execute=force_execute,
        )

        attachments = self._normalized_attachments(event_payload.get("attachments"))

        user_message = await self.store.aappend_context_message(
            conversation_id=conversation["id"],
            role="user",
            content=text,
            metadata={
                "provider": provider,
                "source": source,
                "subject": subject,
                "chat_id": event_payload.get("chat_id"),
                "sender_id": event_payload.get("sender_id"),
                "addressed": decision.addressed,
                "should_execute": decision.should_execute,
                "address_reason": decision.reason,
                "attachments": attachments,
            },
        )
        approval_scope_id = str(event_payload.get("approval_scope_id") or "").strip() or str(user_message["id"])

        result: dict[str, Any] = {
            "conversation_id": conversation["id"],
            "main_context_id": conversation["main_context_id"],
            "addressed": decision.addressed,
            "should_execute": decision.should_execute,
            "address_reason": decision.reason,
            "task_run_id": None,
            "runtime_session_id": None,
            "agent_id": agent_id,
        }

        if not decision.should_execute:
            return result

        task_input = self._build_task_input(
            text=text,
            attachments=attachments,
            gateway_id=gateway_key,
            provider=provider,
            instance_id=instance_id,
            bot_id=bot_id,
            chat_id=chat_id,
        )
        runtime_session_id, forked_from_session_id = await self._resolve_runtime_session_for_execution(
            provider=provider,
            conversation=conversation,
        )
        run = await self.store.acreate_task_run(
            conversation_id=conversation["id"],
            runtime_session_id=runtime_session_id,
            source_message_id=user_message["id"],
            snapshot_version=user_message["context_version"],
            status="queued",
        )
        result["task_run_id"] = run["id"]
        result["runtime_session_id"] = runtime_session_id
        if forked_from_session_id:
            result["forked_from_session_id"] = forked_from_session_id

        if on_result and await self._should_send_immediate_ack(provider):
            ack_text = self._format_immediate_ack_message()
            ack_ok = await on_result(
                ack_text,
                {
                    "chat_id": chat_id,
                    "conversation_id": conversation["id"],
                    "task_run_id": run["id"],
                    "runtime_session_id": runtime_session_id,
                    "status": "received",
                },
            )
            if ack_ok:
                logger.info("gateway_notice_delivered", extra={"kind": "received", "provider": provider})

        async def _execute() -> None:
            await self.store.aupdate_task_run(run["id"], status="running")
            await self.store.aupdate_active_runtime_session_status(
                conversation["id"],
                runtime_session_id=runtime_session_id,
                status="running",
            )
            plan_preview_sent = False
            agent_runtime_config = await self._agent_runtime_config(agent_id)

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
                text_preview = self._format_plan_preview_message(
                    [item for item in steps_list if isinstance(item, dict)]
                )
                ok = await on_result(
                    text_preview,
                    {
                        "chat_id": chat_id,
                        "conversation_id": conversation["id"],
                        "task_run_id": run["id"],
                        "runtime_session_id": runtime_session_id,
                        "status": "planning",
                    },
                )
                if ok:
                    plan_preview_sent = True
                    logger.info("gateway_notice_delivered", extra={"kind": "planning", "provider": provider})
            try:
                recent_tool_usage = await self.store.asummarize_recent_tool_usage(
                    session_id=runtime_session_id,
                    limit=100,
                    success_only=True,
                )
                runner_task = asyncio.create_task(
                    self.task_runner(
                        task=task_input,
                        db_path=self.runtime_db_path,
                        rules_path=self.rules_path,
                        agent_id=agent_id,
                        session_id=runtime_session_id,
                        approval_scope_id=approval_scope_id,
                        model=agent_runtime_config["model"],
                        model_provider_key=agent_runtime_config["model_provider_key"],
                        fallback_model=agent_runtime_config["fallback_model"],
                        fallback_provider_key=agent_runtime_config["fallback_provider_key"],
                        system_prompt=agent_runtime_config["system_prompt"],
                        recent_tool_usage=recent_tool_usage,
                        runtime_event_callback=_runtime_event_callback,
                    )
                )
                deadline = asyncio.get_running_loop().time() + float(self.task_timeout_seconds)
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

                    pending_approval_ids = await self._pending_approval_ids_for_session(runtime_session_id)
                    if pending_approval_ids:
                        runner_task.cancel()
                        with suppress(asyncio.CancelledError):
                            await runner_task

                        msg = self._resolve_awaiting_approval_notice(
                            approval_ids=pending_approval_ids,
                            fallback_message="操作需要人工审批后继续。",
                        )
                        await self.store.aupdate_task_run(
                            run["id"],
                            status="awaiting_approval",
                            result_summary=msg,
                            result_metadata={
                                "status": "awaiting_approval",
                                "notice_kind": "awaiting_approval",
                                "approval_ids": pending_approval_ids,
                            },
                        )
                        await self.store.aupdate_active_runtime_session_status(
                            conversation["id"],
                            runtime_session_id=runtime_session_id,
                            status="awaiting_approval",
                        )
                        if on_result:
                            await on_result(
                                msg,
                                {
                                    "chat_id": chat_id,
                                    "conversation_id": conversation["id"],
                                    "task_run_id": run["id"],
                                    "runtime_session_id": runtime_session_id,
                                    "status": "awaiting_approval",
                                    "notice_kind": "awaiting_approval",
                                    "approval_ids": pending_approval_ids,
                                },
                            )
                        return

                if runtime_result is None:
                    raise TimeoutError
                final_response = str(runtime_result.get("final_response") or "").strip()
                error = str(runtime_result.get("error") or "").strip()
                generated_files = self._extract_generated_files(runtime_result)
                approval_ids = self._extract_pending_approval_ids(runtime_result)
                normalized_runtime_status = str(runtime_result.get("status") or "").strip().lower()
                missing_capability = self._extract_missing_capability(runtime_result)
                proposed_cli_import = self._extract_proposed_cli_import(runtime_result)
                tool_usage_events = self._extract_tool_usage_events(runtime_result, task_run_id=run["id"])
                for event in tool_usage_events:
                    await self.store.acreate_tool_usage_event(
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
                    msg = self._resolve_awaiting_approval_notice(
                        runtime_result=runtime_result,
                        approval_ids=approval_ids,
                        fallback_message=final_response or "操作需要人工审批后继续。",
                    )
                    await self.store.aupdate_task_run(
                        run["id"],
                        status="awaiting_approval",
                        result_summary=msg,
                        result_metadata={
                            "status": "awaiting_approval",
                            "notice_kind": "awaiting_approval",
                            "approval_ids": approval_ids,
                            "runtime_result": runtime_result,
                        },
                    )
                    await self.store.aupdate_active_runtime_session_status(
                        conversation["id"],
                        runtime_session_id=runtime_session_id,
                        status="awaiting_approval",
                    )
                    if on_result:
                        await on_result(
                            msg,
                            {
                                "chat_id": chat_id,
                                "conversation_id": conversation["id"],
                                "task_run_id": run["id"],
                                "runtime_session_id": runtime_session_id,
                                "status": "awaiting_approval",
                                "notice_kind": "awaiting_approval",
                                "approval_ids": approval_ids,
                            },
                        )
                    return
                if normalized_runtime_status in {"failed", "cancelled"}:
                    msg = error or ("任务已取消。" if normalized_runtime_status == "cancelled" else "任务执行失败。")
                    await self.store.aupdate_task_run(
                        run["id"],
                        status="failed" if normalized_runtime_status == "cancelled" else normalized_runtime_status,
                        result_summary=msg,
                        result_metadata={
                            "status": normalized_runtime_status,
                            "notice_kind": "error",
                            "error": error or None,
                            "runtime_result": runtime_result,
                        },
                    )
                    await self.store.aupdate_active_runtime_session_status(
                        conversation["id"],
                        runtime_session_id=runtime_session_id,
                        status="failed" if normalized_runtime_status == "cancelled" else normalized_runtime_status,
                    )
                    if on_result:
                        await on_result(msg, {
                            "chat_id": chat_id,
                            "conversation_id": conversation["id"],
                            "task_run_id": run["id"],
                            "runtime_session_id": runtime_session_id,
                            "status": normalized_runtime_status,
                            "notice_kind": "error",
                            "error": error or None,
                        })
                    return
                if not final_response:
                    final_response = "任务已执行，但没有可返回结果。"
                cli_import_request = None
                if proposed_cli_import:
                    try:
                        cli_registry = create_default_registry()
                        cli_import_request = await create_cli_import_request(
                            config_store=self.config_store,
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
                        final_response = self._append_cli_import_hint(final_response, str(cli_import_request.get("id") or ""))
                    except Exception as exc:
                        logger.warning("gateway_cli_import_request_failed", extra={"error": str(exc), "provider": provider})
                await self.store.aupdate_task_run(
                    run["id"],
                    status="done",
                    result_summary=final_response,
                    result_metadata={
                        "runtime_result": runtime_result,
                        "generated_files": generated_files,
                        "missing_capability": missing_capability,
                        "proposed_cli_import": proposed_cli_import,
                        "cli_import_request": cli_import_request,
                    },
                )
                await self.store.aupdate_active_runtime_session_status(
                    conversation["id"],
                    runtime_session_id=runtime_session_id,
                    status="idle",
                )
                await self.store.aappend_context_message(
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
                    await on_result(final_response, {
                        "chat_id": chat_id,
                        "conversation_id": conversation["id"],
                        "task_run_id": run["id"],
                        "runtime_session_id": runtime_session_id,
                        "files": generated_files,
                        "cli_import_request": cli_import_request,
                    })
            except TimeoutError:
                msg = f"任务执行超时（>{self.task_timeout_seconds}s），请重试或缩小任务范围。"
                await self.store.aupdate_task_run(
                    run["id"],
                    status="failed",
                    result_summary=msg,
                    result_metadata={"error": "timeout", "timeout_sec": self.task_timeout_seconds},
                )
                await self.store.aupdate_active_runtime_session_status(
                    conversation["id"],
                    runtime_session_id=runtime_session_id,
                    status="failed",
                )
                if on_result:
                    await on_result(msg, {
                        "chat_id": chat_id,
                        "conversation_id": conversation["id"],
                        "task_run_id": run["id"],
                        "runtime_session_id": runtime_session_id,
                        "status": "failed",
                        "error": "timeout",
                    })
            except Exception as exc:  # noqa: BLE001
                msg = f"任务执行失败：{exc}"
                await self.store.aupdate_task_run(
                    run["id"],
                    status="failed",
                    result_summary=msg,
                    result_metadata={"error": str(exc)},
                )
                await self.store.aupdate_active_runtime_session_status(
                    conversation["id"],
                    runtime_session_id=runtime_session_id,
                    status="failed",
                )
                if on_result:
                    await on_result(msg, {
                        "chat_id": chat_id,
                        "conversation_id": conversation["id"],
                        "task_run_id": run["id"],
                        "runtime_session_id": runtime_session_id,
                        "status": "failed",
                    })

        def _on_task_done(task: asyncio.Task[None]) -> None:
            if not task.cancelled() and task.exception() is not None:
                logger.error(
                    "[GatewayContext] 执行任务异常 conversation_id=%s",
                    conversation.get("id"),
                    exc_info=task.exception(),
                )

        task = asyncio.create_task(_execute())
        task.add_done_callback(_on_task_done)
        return result

    def list_conversations(self, *, provider: str | None = None, limit: int = 100) -> list[dict[str, Any]]:
        return self.store.list_conversations(provider=provider, limit=limit)

    def list_task_runs(self, conversation_id: str, *, limit: int = 100) -> list[dict[str, Any]]:
        return self.store.list_task_runs(conversation_id, limit=limit)

    def list_context(self, conversation_id: str, *, limit: int = 200) -> list[dict[str, Any]]:
        return self.store.list_context_messages(conversation_id, limit=limit)
