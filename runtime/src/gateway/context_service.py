"""Unified Gateway Context Service (GCS).

This service keeps gateway-level main context stable and runs runtime tasks in
isolated runtime sessions, then appends minimal result back to gateway context.
"""

from __future__ import annotations

import asyncio
import logging
import os
import shutil
from contextlib import suppress
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any
from uuid import uuid4

from src.events.event_store import EventStore
from src.gateway.gateway_dispatch_service import prepare_gateway_execution
from src.gateway.policies.addressing import AddressingDecision, decide_addressing
from src.gateway.gateway_execution_service import execute_gateway_run, resume_gateway_execution
from src.gateway.store.gateway_store import GatewayStore
from src.server.config_store import RuntimeConfigStore
from src.constants.config import (
    GATEWAY_APPROVAL_LIST_LIMIT,
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

    async def _run_execution_via_runtime_facade(
        self,
        *,
        run: dict[str, Any],
        task_input: str,
        runtime_session_id: str,
        approval_scope_id: str,
        agent_id: str,
        agent_runtime_config: dict[str, Any],
        recent_tool_usage: dict[str, int],
        runtime_event_callback: Callable[[dict[str, Any]], Awaitable[None]] | None = None,
    ) -> dict[str, Any]:
        return await self.task_runner(
            task=task_input,
            db_path=self.runtime_db_path,
            rules_path=self.rules_path,
            agent_id=agent_id,
            session_id=runtime_session_id,
            attempt_id=str(run.get("id") or "").strip() or None,
            user_message_id=str(run.get("source_message_id") or "").strip() or None,
            approval_scope_id=approval_scope_id,
            model=agent_runtime_config["model"],
            model_provider_key=agent_runtime_config["model_provider_key"],
            fallback_model=agent_runtime_config["fallback_model"],
            fallback_provider_key=agent_runtime_config["fallback_provider_key"],
            model_roles=agent_runtime_config["model_roles"],
            system_prompt=agent_runtime_config["system_prompt"],
            recent_tool_usage=recent_tool_usage,
            runtime_event_callback=runtime_event_callback,
        )

    @staticmethod
    def _session_busy(status: str | None) -> bool:
        return str(status or "").strip().lower() in {"queued", "running", "awaiting_approval"}

    @staticmethod
    def _session_reusable(status: str | None) -> bool:
        normalized = str(status or "").strip().lower()
        return normalized in {"idle", "done", "completed", "received", "planning", ""}

    @staticmethod
    def _new_runtime_session_id(provider: str) -> str:
        return f"sess_{provider}_{uuid4().hex[:12]}"

    @staticmethod
    def _requested_context_strategy(event_payload: dict[str, Any] | None) -> str:
        strategy = str(
            (event_payload or {}).get("context_strategy")
            or (event_payload or {}).get("execution_context_strategy")
            or ""
        ).strip().lower()
        return "fork" if strategy == "fork" else "fresh"

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
        event_payload: dict[str, Any] | None = None,
    ) -> tuple[str, str | None]:
        strategy = str((event_payload or {}).get("context_strategy") or (event_payload or {}).get("execution_context_strategy") or "").strip().lower()
        source_session_id = await self._resolve_fork_source_session_id(
            conversation=conversation,
            event_payload=event_payload or {},
        )

        if strategy == "fork" and source_session_id:
            forked = self._fork_runtime_session(provider=provider, source_session_id=source_session_id)
            await self.store.aset_active_runtime_session(
                conversation["id"],
                runtime_session_id=forked,
                status="queued",
                forked_from_session_id=source_session_id,
            )
            return forked, source_session_id

        created = self._new_runtime_session_id(provider)
        await self.store.aset_active_runtime_session(
            conversation["id"],
            runtime_session_id=created,
            status="queued",
            forked_from_session_id=None,
        )
        return created, None

    async def _resolve_fork_source_session_id(
        self,
        *,
        conversation: dict[str, Any],
        event_payload: dict[str, Any],
    ) -> str | None:
        explicit_session_id = str(
            event_payload.get("source_runtime_session_id")
            or event_payload.get("fork_from_session_id")
            or ""
        ).strip()
        if explicit_session_id:
            return explicit_session_id

        run_id = str(
            event_payload.get("source_task_run_id")
            or event_payload.get("fork_from_task_run_id")
            or ""
        ).strip()
        if run_id:
            run = await self.store.aget_task_run(run_id)
            if run and str(run.get("conversation_id") or "") == str(conversation.get("id") or ""):
                source_runtime_session_id = str(run.get("runtime_session_id") or "").strip()
                if source_runtime_session_id:
                    return source_runtime_session_id
        return None

    async def _resolve_fork_source_run(
        self,
        *,
        conversation: dict[str, Any],
        event_payload: dict[str, Any],
    ) -> dict[str, Any] | None:
        run_id = str(
            event_payload.get("source_task_run_id")
            or event_payload.get("fork_from_task_run_id")
            or ""
        ).strip()
        if not run_id:
            return None
        run = await self.store.aget_task_run(run_id)
        if not run:
            return None
        if str(run.get("conversation_id") or "") != str(conversation.get("id") or ""):
            return None
        return run

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

    @staticmethod
    def _merge_model_roles(
        base: dict[str, Any] | None,
        override: dict[str, Any] | None,
    ) -> dict[str, Any] | None:
        base_map = base if isinstance(base, dict) else {}
        override_map = override if isinstance(override, dict) else {}
        if not base_map and not override_map:
            return None
        merged: dict[str, Any] = {}
        for role in ("plan", "act", "textProcessing", "text_processing"):
            role_base = base_map.get(role)
            role_override = override_map.get(role)
            if isinstance(role_base, dict) or isinstance(role_override, dict):
                payload: dict[str, Any] = {}
                if isinstance(role_base, dict):
                    payload.update(role_base)
                if isinstance(role_override, dict):
                    payload.update(role_override)
                if payload:
                    merged[role] = payload
        return merged or None

    @staticmethod
    def _pick_primary_model_from_roles(model_roles: dict[str, Any] | None) -> str | None:
        roles = model_roles if isinstance(model_roles, dict) else {}
        for key in ("plan", "act", "respond", "textProcessing", "text_processing"):
            item = roles.get(key)
            if not isinstance(item, dict):
                continue
            model = str(item.get("model") or "").strip()
            if model:
                return model
        return None

    async def _agent_runtime_config(self, agent_id: str) -> dict[str, Any]:
        safe_agent_id = str(agent_id or "").strip()
        llm_settings = await self.config_store.aget_llm_settings() or {}
        global_roles = (
            llm_settings.get("model_roles")
            if isinstance(llm_settings.get("model_roles"), dict)
            else None
        )
        global_primary_model = self._pick_primary_model_from_roles(global_roles)
        if not safe_agent_id:
            return {
                "model": global_primary_model or str(llm_settings.get("default_model") or "").strip() or None,
                "model_provider_key": None,
                "fallback_model": str(llm_settings.get("fallback_model") or "").strip() or None,
                "fallback_provider_key": None,
                "system_prompt": None,
                "model_roles": global_roles,
            }

        profile = await self.config_store.aget_agent_profile(safe_agent_id) or {}
        metadata = profile.get("metadata")
        metadata_map = metadata if isinstance(metadata, dict) else {}
        config = metadata_map.get("config")
        config_map = config if isinstance(config, dict) else {}
        default_roles = global_roles
        config_roles = config_map.get("modelRoles") if isinstance(config_map.get("modelRoles"), dict) else (
            config_map.get("model_roles") if isinstance(config_map.get("model_roles"), dict) else None
        )
        merged_roles = self._merge_model_roles(default_roles, config_roles)
        role_primary_model = self._pick_primary_model_from_roles(merged_roles)

        def _clean(value: Any) -> str | None:
            text = str(value or "").strip()
            return text or None

        return {
            "model": (
                _clean(profile.get("model"))
                or role_primary_model
                or _clean(llm_settings.get("default_model"))
            ),
            "model_provider_key": _clean(
                config_map.get("modelProviderKey") or config_map.get("model_provider_key")
            ),
            "fallback_model": _clean(
                config_map.get("fallbackModel") or config_map.get("fallback_model")
            ) or _clean(llm_settings.get("fallback_model")),
            "fallback_provider_key": _clean(
                config_map.get("fallbackProviderKey") or config_map.get("fallback_provider_key")
            ),
            "system_prompt": _clean(
                profile.get("system_prompt")
                or config_map.get("systemPrompt")
                or config_map.get("system_prompt")
            ),
            "model_roles": merged_roles,
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
    def _build_execution_title(text: str) -> str:
        compact = " ".join(str(text or "").strip().split())
        if not compact:
            return "未命名任务"
        return compact[:80]

    async def bind_anchor_delivery(
        self,
        *,
        anchor_id: str | None,
        channel_message_id: str | None = None,
        channel_thread_id: str | None = None,
    ) -> dict[str, Any] | None:
        anchor = str(anchor_id or "").strip()
        if not anchor:
            return None
        message_id = str(channel_message_id or "").strip()
        thread_id = str(channel_thread_id or "").strip() or None
        if not message_id and not thread_id:
            return None
        return await self.store.aupdate_interaction_anchor(
            anchor,
            channel_message_id=message_id or None,
            channel_thread_id=thread_id,
        )

    async def _start_execution(
        self,
        *,
        provider: str,
        conversation: dict[str, Any],
        run: dict[str, Any],
        runtime_session_id: str,
        task_input: str,
        approval_scope_id: str,
        chat_id: str,
        agent_id: str,
        on_result: ReplySender | None = None,
    ) -> None:
        agent_runtime_config = await self._agent_runtime_config(agent_id)
        await execute_gateway_run(
            store=self.store,
            config_store=self.config_store,
            provider=provider,
            conversation=conversation,
            run=run,
            runtime_session_id=runtime_session_id,
            task_input=task_input,
            approval_scope_id=approval_scope_id,
            chat_id=chat_id,
            agent_id=agent_id,
            task_timeout_seconds=self.task_timeout_seconds,
            on_result=on_result,
            run_execution_via_runtime_facade=self._run_execution_via_runtime_facade,
            agent_runtime_config=agent_runtime_config,
            summarize_recent_tool_usage=self.store.asummarize_recent_tool_usage,
            pending_approval_ids_for_scope=self._pending_approval_ids_for_scope,
            resolve_awaiting_approval_notice=self._resolve_awaiting_approval_notice,
            format_plan_preview_message=self._format_plan_preview_message,
            extract_generated_files=self._extract_generated_files,
            extract_pending_approval_ids=self._extract_pending_approval_ids,
            extract_missing_capability=self._extract_missing_capability,
            extract_proposed_cli_import=self._extract_proposed_cli_import,
            extract_tool_usage_events=lambda runtime_result: self._extract_tool_usage_events(runtime_result, task_run_id=run["id"]),
            append_cli_import_hint=self._append_cli_import_hint,
        )

    @staticmethod
    def _log_execution_task_exception(task: asyncio.Task[None], *, conversation_id: str | None) -> None:
        if not task.cancelled() and task.exception() is not None:
            logger.error(
                "[GatewayContext] 执行任务异常 conversation_id=%s",
                conversation_id,
                exc_info=task.exception(),
            )

    def _spawn_execution_task(
        self,
        *,
        provider: str,
        conversation: dict[str, Any],
        run: dict[str, Any],
        runtime_session_id: str,
        task_input: str,
        approval_scope_id: str,
        chat_id: str,
        agent_id: str,
        on_result: ReplySender | None = None,
    ) -> asyncio.Task[None]:
        async def _execute() -> None:
            await self._start_execution(
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

        task = asyncio.create_task(_execute())
        task.add_done_callback(
            lambda done_task: self._log_execution_task_exception(
                done_task,
                conversation_id=str(conversation.get("id") or "").strip() or None,
            )
        )
        return task

    async def resume_execution(
        self,
        *,
        provider: str,
        execution_id: str,
        chat_id: str,
        agent_id: str = "semibot",
        on_result: ReplySender | None = None,
    ) -> dict[str, Any]:
        return await resume_gateway_execution(
            store=self.store,
            provider=provider,
            execution_id=execution_id,
            chat_id=chat_id,
            agent_id=agent_id,
            on_result=on_result,
            fork_runtime_session=self._fork_runtime_session,
            spawn_execution_task=self._spawn_execution_task,
        )

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

    async def _pending_approval_ids_for_scope(self, approval_scope_id: str) -> list[str]:
        approvals = await asyncio.to_thread(self.event_store.list_approvals, status="pending", limit=GATEWAY_APPROVAL_LIST_LIMIT)
        ids: list[str] = []
        scope = str(approval_scope_id or "").strip()
        if not scope:
            return ids
        for item in approvals:
            context = item.context if isinstance(getattr(item, "context", None), dict) else {}
            candidate_scope = str(context.get("approval_scope_id") or context.get("session_id") or "").strip()
            if candidate_scope != scope:
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

        dispatch = await prepare_gateway_execution(
            store=self.store,
            provider=provider,
            conversation=conversation,
            event_payload=event_payload,
            text=text,
            attachments=attachments,
            gateway_key=gateway_key,
            instance_id=instance_id,
            bot_id=bot_id,
            chat_id=chat_id,
            user_message=user_message,
            resolve_fork_source_run=self._resolve_fork_source_run,
            requested_context_strategy=self._requested_context_strategy,
            build_execution_title=self._build_execution_title,
            build_task_input=self._build_task_input,
            resolve_runtime_session_for_execution=self._resolve_runtime_session_for_execution,
        )
        run = dispatch["run"]
        task_input = dispatch["task_input"]
        runtime_session_id = dispatch["runtime_session_id"]
        context_strategy = dispatch["context_strategy"]
        context_snapshot = dispatch["context_snapshot"]
        anchor = dispatch["anchor"]
        forked_from_session_id = dispatch["forked_from_session_id"]
        result["task_run_id"] = run["id"]
        result["runtime_session_id"] = runtime_session_id
        result["context_strategy"] = context_strategy
        result["context_snapshot_id"] = context_snapshot["id"]
        result["anchor_id"] = anchor["id"]
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
                    "anchor_id": anchor["id"],
                    "status": "received",
                },
            )
            if ack_ok:
                logger.info("gateway_notice_delivered", extra={"kind": "received", "provider": provider})

        self._spawn_execution_task(
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
        return result

    def list_conversations(self, *, provider: str | None = None, limit: int = 100) -> list[dict[str, Any]]:
        return self.store.list_conversations(provider=provider, limit=limit)

    def list_task_runs(self, conversation_id: str, *, limit: int = 100) -> list[dict[str, Any]]:
        return self.store.list_task_runs(conversation_id, limit=limit)

    def list_context(self, conversation_id: str, *, limit: int = 200) -> list[dict[str, Any]]:
        return self.store.list_context_messages(conversation_id, limit=limit)

    @staticmethod
    def _is_actionable_execution(run: dict[str, Any] | None) -> bool:
        if not isinstance(run, dict):
            return False
        return not str(run.get("archived_at") or "").strip()

    async def find_executions_for_approval_ids(
        self,
        *,
        approval_ids: list[str],
        conversation_id: str | None = None,
        statuses: list[str] | None = None,
    ) -> list[dict[str, Any]]:
        return await self.store.afind_task_runs_by_approval_ids(
            approval_ids,
            conversation_id=conversation_id,
            statuses=statuses or ["awaiting_approval"],
            include_archived=False,
        )

    async def resolve_execution_target(
        self,
        *,
        provider: str,
        execution_id: str | None = None,
        anchor_id: str | None = None,
        channel_message_id: str | None = None,
        channel_target_id: str | None = None,
        approval_id: str | None = None,
        conversation_id: str | None = None,
    ) -> dict[str, Any] | None:
        execution = str(execution_id or "").strip()
        if execution:
            run = await self.store.aget_task_run(execution)
            return run if self._is_actionable_execution(run) else None

        anchor = str(anchor_id or "").strip()
        if anchor:
            anchor_row = await self.store.aget_interaction_anchor(anchor)
            if anchor_row:
                run = await self.store.aget_task_run(str(anchor_row.get("execution_id") or "").strip())
                return run if self._is_actionable_execution(run) else None

        message_id = str(channel_message_id or "").strip()
        if message_id:
            anchor_row = await self.store.aget_interaction_anchor_by_channel_message(
                provider=provider,
                channel_message_id=message_id,
                channel_target_id=str(channel_target_id or "").strip() or None,
            )
            if anchor_row:
                run = await self.store.aget_task_run(str(anchor_row.get("execution_id") or "").strip())
                return run if self._is_actionable_execution(run) else None

        approval = str(approval_id or "").strip()
        if approval:
            matches = await self.find_executions_for_approval_ids(
                approval_ids=[approval],
                conversation_id=conversation_id,
            )
            if matches:
                return matches[0]
        return None

    async def archive_old_executions(
        self,
        *,
        retention_days: int = 7,
        statuses: list[str] | None = None,
    ) -> int:
        return await self.store.aarchive_old_task_runs(
            retention_days=retention_days,
            statuses=statuses,
        )
