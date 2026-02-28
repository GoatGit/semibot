"""Unified Gateway Context Service (GCS).

This service keeps gateway-level main context stable and runs runtime tasks in
isolated runtime sessions, then appends minimal result back to gateway context.
"""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import uuid4

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
        self.config_store = config_store
        self.task_runner = task_runner
        self.runtime_db_path = runtime_db_path
        self.rules_path = rules_path

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
        force_execute: bool = False,
    ) -> AddressingDecision:
        if force_execute:
            return AddressingDecision(addressed=True, should_execute=True, reason="forced")
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
            force_execute=force_execute,
        )

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
            },
        )

        result: dict[str, Any] = {
            "conversation_id": conversation["id"],
            "main_context_id": conversation["main_context_id"],
            "addressed": decision.addressed,
            "should_execute": decision.should_execute,
            "address_reason": decision.reason,
            "task_run_id": None,
            "runtime_session_id": None,
        }

        if not decision.should_execute:
            return result

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
            try:
                runtime_result = await self.task_runner(
                    task=text,
                    db_path=self.runtime_db_path,
                    rules_path=self.rules_path,
                    agent_id=agent_id,
                    session_id=runtime_session_id,
                    model=None,
                    system_prompt=None,
                )
                final_response = str(runtime_result.get("final_response") or "").strip()
                if not final_response:
                    error = str(runtime_result.get("error") or "").strip()
                    final_response = f"任务执行失败：{error}" if error else "任务已执行，但没有可返回结果。"
                self.store.update_task_run(
                    run["id"],
                    status="done",
                    result_summary=final_response,
                    result_metadata={"runtime_result": runtime_result},
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
                    },
                )
                if on_result:
                    await on_result(final_response, {
                        "chat_id": chat_id,
                        "conversation_id": conversation["id"],
                        "task_run_id": run["id"],
                        "runtime_session_id": runtime_session_id,
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
