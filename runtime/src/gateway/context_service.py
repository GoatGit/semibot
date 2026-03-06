"""Unified Gateway Context Service (GCS).

This service keeps gateway-level main context stable and runs runtime tasks in
isolated runtime sessions, then appends minimal result back to gateway context.
"""

from __future__ import annotations

import asyncio
from contextlib import suppress
import os
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import uuid4

from src.events.event_store import EventStore
from src.gateway.policies.addressing import AddressingDecision, decide_addressing
from src.gateway.store.gateway_store import GatewayStore
from src.server.config_store import RuntimeConfigStore

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
        timeout_raw = str(os.getenv("SEMIBOT_GATEWAY_TASK_TIMEOUT_SEC", "600")).strip()
        self.task_timeout_seconds = int(timeout_raw) if timeout_raw.isdigit() and int(timeout_raw) > 0 else 600

    def _provider_config(self, provider: str) -> dict[str, Any]:
        item = self.config_store.get_gateway_config(provider) or {}
        cfg = item.get("config")
        return cfg if isinstance(cfg, dict) else {}

    def _addressing_policy(self, provider: str) -> dict[str, Any]:
        cfg = self._provider_config(provider)
        policy = cfg.get("addressingPolicy")
        if isinstance(policy, dict):
            return policy
        default_mode = "all_messages" if provider == "telegram" else "mention_only"
        return {
            "mode": default_mode,
            "allowReplyToBot": True,
            "executeOnUnaddressed": False,
            "commandPrefixes": ["/ask", "/run", "/approve", "/reject"],
            "sessionContinuationWindowSec": 300,
        }

    def _gateway_key(self, *, provider: str, bot_id: str, chat_id: str) -> str:
        return f"{provider}:{bot_id}:{chat_id}"

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
        top = steps[:8]
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

    def _pending_approval_ids_for_session(self, session_id: str) -> list[str]:
        approvals = self.event_store.list_approvals(status="pending", limit=1000)
        ids: list[str] = []
        for item in approvals:
            context = item.context if isinstance(getattr(item, "context", None), dict) else {}
            if str(context.get("session_id") or "").strip() != session_id:
                continue
            approval_id = str(getattr(item, "approval_id", "") or "").strip()
            if approval_id:
                ids.append(approval_id)
        return ids

    def _conversation_identity(self, provider: str, payload: dict[str, Any]) -> tuple[str, str]:
        chat_id = str(payload.get("chat_id") or payload.get("subject") or "").strip()
        if not chat_id:
            chat_id = "unknown"

        if provider == "telegram":
            bot_id = str(payload.get("bot_id") or self._provider_config("telegram").get("botId") or "telegram-bot").strip()
        else:
            feishu_cfg = self._provider_config("feishu")
            bot_id = str(payload.get("app_id") or feishu_cfg.get("appId") or "feishu-app").strip()
        if not bot_id:
            bot_id = "unknown-bot"
        return bot_id, chat_id

    def _continuation_hit(self, conversation_id: str, policy: dict[str, Any]) -> bool:
        window = int(policy.get("sessionContinuationWindowSec") or 0)
        if window <= 0:
            return False
        last_assistant_at = self.store.latest_assistant_at(conversation_id)
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
        policy = self._addressing_policy(provider)
        continuation_hit = self._continuation_hit(conversation_id, policy)
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
        bot_id, chat_id = self._conversation_identity(provider, event_payload)
        gateway_key = self._gateway_key(provider=provider, bot_id=bot_id, chat_id=chat_id)
        conversation = self.store.get_or_create_conversation(
            provider=provider,
            gateway_key=gateway_key,
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

        user_message = self.store.append_context_message(
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
            bot_id=bot_id,
            chat_id=chat_id,
        )
        runtime_session_id = f"sess_{provider}_{uuid4().hex[:12]}"
        run = self.store.create_task_run(
            conversation_id=conversation["id"],
            runtime_session_id=runtime_session_id,
            source_message_id=user_message["id"],
            snapshot_version=user_message["context_version"],
            status="queued",
        )
        result["task_run_id"] = run["id"]
        result["runtime_session_id"] = runtime_session_id

        async def _execute() -> None:
            self.store.update_task_run(run["id"], status="running")
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
                    self.store.append_context_message(
                        conversation_id=conversation["id"],
                        role="assistant",
                        content=text_preview,
                        metadata={
                            "provider": provider,
                            "task_run_id": run["id"],
                            "runtime_session_id": runtime_session_id,
                            "minimal_writeback": True,
                            "status": "planning",
                        },
                    )
            try:
                runner_task = asyncio.create_task(
                    self.task_runner(
                        task=task_input,
                        db_path=self.runtime_db_path,
                        rules_path=self.rules_path,
                        agent_id=agent_id,
                        session_id=runtime_session_id,
                        approval_scope_id=approval_scope_id,
                        model=None,
                        system_prompt=None,
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

                    done, _ = await asyncio.wait({runner_task}, timeout=min(1.0, remaining))
                    if runner_task in done:
                        runtime_result = await runner_task
                        break

                    pending_approval_ids = self._pending_approval_ids_for_session(runtime_session_id)
                    if pending_approval_ids:
                        runner_task.cancel()
                        with suppress(asyncio.CancelledError):
                            await runner_task

                        msg = self._append_approval_hints("操作需要人工审批后继续。", pending_approval_ids)
                        self.store.update_task_run(
                            run["id"],
                            status="awaiting_approval",
                            result_summary=msg,
                            result_metadata={
                                "status": "awaiting_approval",
                                "approval_ids": pending_approval_ids,
                            },
                        )
                        self.store.append_context_message(
                            conversation_id=conversation["id"],
                            role="assistant",
                            content=msg,
                            metadata={
                                "provider": provider,
                                "task_run_id": run["id"],
                                "runtime_session_id": runtime_session_id,
                                "minimal_writeback": True,
                                "status": "awaiting_approval",
                                "approval_ids": pending_approval_ids,
                            },
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
                                    "approval_ids": pending_approval_ids,
                                },
                            )
                        return

                if runtime_result is None:
                    raise TimeoutError
                final_response = str(runtime_result.get("final_response") or "").strip()
                if not final_response:
                    error = str(runtime_result.get("error") or "").strip()
                    final_response = f"任务执行失败：{error}" if error else "任务已执行，但没有可返回结果。"
                generated_files = self._extract_generated_files(runtime_result)
                approval_ids = self._extract_pending_approval_ids(runtime_result)
                final_response = self._append_approval_hints(final_response, approval_ids)
                self.store.update_task_run(
                    run["id"],
                    status="done",
                    result_summary=final_response,
                    result_metadata={
                        "runtime_result": runtime_result,
                        "generated_files": generated_files,
                    },
                )
                self.store.append_context_message(
                    conversation_id=conversation["id"],
                    role="assistant",
                    content=final_response,
                    metadata={
                        "provider": provider,
                        "task_run_id": run["id"],
                        "runtime_session_id": runtime_session_id,
                        "minimal_writeback": True,
                        "generated_files": generated_files,
                    },
                )
                if on_result:
                    await on_result(final_response, {
                        "chat_id": chat_id,
                        "conversation_id": conversation["id"],
                        "task_run_id": run["id"],
                        "runtime_session_id": runtime_session_id,
                        "files": generated_files,
                    })
            except TimeoutError:
                msg = f"任务执行超时（>{self.task_timeout_seconds}s），请重试或缩小任务范围。"
                self.store.update_task_run(
                    run["id"],
                    status="failed",
                    result_summary=msg,
                    result_metadata={"error": "timeout", "timeout_sec": self.task_timeout_seconds},
                )
                self.store.append_context_message(
                    conversation_id=conversation["id"],
                    role="assistant",
                    content=msg,
                    metadata={
                        "provider": provider,
                        "task_run_id": run["id"],
                        "runtime_session_id": runtime_session_id,
                        "minimal_writeback": True,
                        "status": "failed",
                        "error": "timeout",
                    },
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
                self.store.update_task_run(
                    run["id"],
                    status="failed",
                    result_summary=msg,
                    result_metadata={"error": str(exc)},
                )
                self.store.append_context_message(
                    conversation_id=conversation["id"],
                    role="assistant",
                    content=msg,
                    metadata={
                        "provider": provider,
                        "task_run_id": run["id"],
                        "runtime_session_id": runtime_session_id,
                        "minimal_writeback": True,
                        "status": "failed",
                    },
                )
                if on_result:
                    await on_result(msg, {
                        "chat_id": chat_id,
                        "conversation_id": conversation["id"],
                        "task_run_id": run["id"],
                        "runtime_session_id": runtime_session_id,
                        "status": "failed",
                    })

        asyncio.create_task(_execute())
        return result

    def list_conversations(self, *, provider: str | None = None, limit: int = 100) -> list[dict[str, Any]]:
        return self.store.list_conversations(provider=provider, limit=limit)

    def list_task_runs(self, conversation_id: str, *, limit: int = 100) -> list[dict[str, Any]]:
        return self.store.list_task_runs(conversation_id, limit=limit)

    def list_context(self, conversation_id: str, *, limit: int = 200) -> list[dict[str, Any]]:
        return self.store.list_context_messages(conversation_id, limit=limit)
