from __future__ import annotations

import json
import os
import re
from dataclasses import asdict, dataclass
from typing import TYPE_CHECKING, Any

from src.memory.local_memory import LocalShortTermMemory
from src.utils.logging import get_logger

if TYPE_CHECKING:
    from src.ws.client import ControlPlaneClient

logger = get_logger(__name__)

_DEFAULT_SHORT_TERM_BUDGET_CHARS = 12000
_DEFAULT_SHORT_TERM_COMPACT_TARGET_CHARS = 3200
_DEFAULT_LONG_TERM_LIMIT = 5
_AUTO_CONSOLIDATE_REMAINING_RATIO = 0.25
_TURN_BLOCK_REGEX = re.compile(r"(?ims)^\[(user|assistant|system)\]\s*[\s\S]*?(?=^\[(?:user|assistant|system)\]\s|\Z)")


def _truncate_text(value: str, limit: int) -> tuple[str, bool]:
    text = str(value or "")
    if len(text) <= limit:
        return text, False
    return text[:limit], True


def _get_llm_provider(runtime_context: Any) -> Any:
    metadata = getattr(runtime_context, "metadata", None)
    return metadata.get("llm_provider") if isinstance(metadata, dict) else None


@dataclass
class ShortTermBudget:
    used_chars: int
    budget_chars: int
    remaining_chars: int
    remaining_ratio: float
    remaining_percent: int

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def prepare_memory_context_for_prompt(memory_context: str, *, max_chars: int) -> str:
    text = str(memory_context or "").strip()
    if not text:
        return ""
    text = re.sub(r"(?is)<skill_md>.*?</skill_md>", "", text)
    text = re.sub(
        r"(?ims)^\[user\]\s*\[SYSTEM\]\s*REPLAN[\s\S]*?(?=^\[(?:user|assistant|system)\]\s|\Z)",
        "",
        text,
    )
    turn_matches = list(_TURN_BLOCK_REGEX.finditer(text))
    if not turn_matches:
        return text[:max_chars]

    prefix = text[: turn_matches[0].start()].strip()
    turns: list[tuple[str, str]] = []
    max_assistant_turn_chars = max(300, max_chars // 2)
    for match in turn_matches:
        role = str(match.group(1) or "").strip().lower()
        block = match.group(0).strip()
        if not block:
            continue
        lower = block.lower()
        if role == "system" or "[system] replan" in lower or "<skill_md>" in lower or "</skill_md>" in lower:
            continue
        if role == "assistant" and len(block) > max_assistant_turn_chars:
            block = block[:max_assistant_turn_chars].rstrip() + "\n...(assistant history truncated)..."
        turns.append((role, block))

    if not turns:
        return prefix[:max_chars] if prefix else ""

    kept_reversed: list[tuple[str, str]] = []
    kept_chars = 0
    for role, block in reversed(turns):
        candidate = block
        candidate_chars = len(candidate) + 2
        remaining = max_chars - kept_chars
        if remaining <= 0:
            break
        if candidate_chars > remaining:
            if role != "user":
                continue
            if remaining < 120:
                continue
            candidate = candidate[: max(0, remaining - 24)].rstrip() + "\n...(truncated)..."
            candidate_chars = len(candidate) + 2
        kept_reversed.append((role, candidate))
        kept_chars += candidate_chars
        if kept_chars >= max_chars:
            break

    kept_turns = list(reversed(kept_reversed))
    if not any(role == "user" for role, _ in kept_turns):
        latest_user_memory = next((block for role, block in reversed(turns) if role == "user"), "")
        if latest_user_memory:
            kept_turns = [("user", latest_user_memory[: max(160, max_chars // 2)].rstrip())]

    parts: list[str] = []
    if prefix:
        parts.append(prefix)
    parts.extend(block for _, block in kept_turns)
    return "\n\n".join(part for part in parts if part.strip()).strip()[:max_chars]


def empty_memory_snapshot(*, budget_chars: int | None = None) -> dict[str, Any]:
    effective_budget = max(1, int(budget_chars or _DEFAULT_SHORT_TERM_BUDGET_CHARS))
    return {
        "memory_context": "",
        "short_term": "",
        "long_term_results": [],
        "budget": {
            "used_chars": 0,
            "budget_chars": effective_budget,
            "remaining_chars": effective_budget,
            "remaining_ratio": 1.0,
            "remaining_percent": 100,
        },
    }


def render_memory_snapshot(memory_snapshot: dict[str, Any] | None) -> str:
    snapshot = memory_snapshot if isinstance(memory_snapshot, dict) else {}
    short_term = str(snapshot.get("short_term") or "").strip()
    long_term_results = snapshot.get("long_term_results")
    parts: list[str] = []
    if short_term:
        parts.append(f"Recent context:\n{short_term}")
    if isinstance(long_term_results, list):
        rendered_long_term = [
            str(item.get("content") or "").strip()
            for item in long_term_results
            if isinstance(item, dict) and str(item.get("content") or "").strip()
        ]
        if rendered_long_term:
            parts.append("Relevant knowledge:\n" + "\n\n".join(rendered_long_term))
    rendered = "\n\n".join(parts).strip()
    if rendered:
        return rendered
    return str(snapshot.get("memory_context") or "").strip()


class RuntimeMemoryService:
    def __init__(
        self,
        *,
        client: "ControlPlaneClient | None",
        base_dir: str,
        llm_provider: Any = None,
        act_model: str | None = None,
        short_term_budget_chars: int | None = None,
        bound_session_id: str | None = None,
        event_emitter: Any = None,
    ) -> None:
        self.client = client
        self.short_term = LocalShortTermMemory(base_dir)
        self.llm_provider = llm_provider
        self.act_model = act_model or None
        self.bound_session_id = str(bound_session_id or "").strip() or None
        self.event_emitter = event_emitter
        self.short_term_budget_chars = max(
            1,
            int(
                short_term_budget_chars
                or os.getenv("SEMIBOT_SHORT_TERM_MEMORY_BUDGET_CHARS", str(_DEFAULT_SHORT_TERM_BUDGET_CHARS))
            ),
        )

    def _enforce_bound_session(self, session_id: str | None) -> str:
        requested = str(session_id or "").strip()
        if self.bound_session_id:
            if not requested or requested != self.bound_session_id:
                self._emit_memory_session_guard_blocked(requested, self.bound_session_id)
                raise ValueError("memory service is bound to the current session")
            return self.bound_session_id
        return requested

    def _emit_memory_session_guard_blocked(self, requested_session_id: str, bound_session_id: str) -> None:
        event_emitter = self.event_emitter
        if event_emitter is None or not hasattr(event_emitter, "emit_memory_session_guard_blocked"):
            return
        try:
            import asyncio

            loop = asyncio.get_running_loop()
            loop.create_task(
                event_emitter.emit_memory_session_guard_blocked(
                    requested_session_id=requested_session_id,
                    bound_session_id=bound_session_id,
                )
            )
        except Exception:
            logger.warning(
                "memory_session_guard_blocked_event_failed",
                extra={
                    "requested_session_id": requested_session_id,
                    "bound_session_id": bound_session_id,
                },
            )

    async def _emit_memory_short_term_compacted(
        self,
        *,
        session_id: str,
        used_chars_before: int,
        used_chars_after: int,
    ) -> None:
        event_emitter = self.event_emitter
        if event_emitter is None or not hasattr(event_emitter, "emit_memory_short_term_compacted"):
            return
        try:
            await event_emitter.emit_memory_short_term_compacted(
                session_id=session_id,
                used_chars_before=used_chars_before,
                used_chars_after=used_chars_after,
            )
        except Exception:
            logger.warning("memory_short_term_compacted_event_failed", extra={"session_id": session_id})

    async def _emit_memory_long_term_written(
        self,
        *,
        session_id: str,
        memory_type: str,
        importance: float,
        content_preview: str,
    ) -> None:
        event_emitter = self.event_emitter
        if event_emitter is None or not hasattr(event_emitter, "emit_memory_long_term_written"):
            return
        try:
            await event_emitter.emit_memory_long_term_written(
                session_id=session_id,
                memory_type=memory_type,
                importance=importance,
                content_preview=content_preview[:240],
            )
        except Exception:
            logger.warning("memory_long_term_written_event_failed", extra={"session_id": session_id})

    async def read_short_term(self, session_id: str) -> str:
        return await self.short_term.read(self._enforce_bound_session(session_id))

    async def get_short_term(self, session_id: str) -> str:
        return await self.read_short_term(session_id)

    async def append_short_term(self, session_id: str, content: str) -> None:
        session_id = self._enforce_bound_session(session_id)
        if str(content or "").strip():
            await self.short_term.append(session_id, content)

    async def replace_short_term(self, session_id: str, content: str) -> None:
        await self.short_term.replace(self._enforce_bound_session(session_id), str(content or ""))

    async def snapshot_short_term(self, session_id: str) -> dict[str, Any]:
        session_id = self._enforce_bound_session(session_id)
        snapshot = await self.short_term.snapshot(session_id)
        budget = await self.get_short_term_budget(session_id)
        snapshot["budget"] = budget.to_dict()
        return snapshot

    async def get_short_term_budget(
        self,
        session_id: str,
        max_chars: int | None = None,
    ) -> ShortTermBudget:
        session_id = self._enforce_bound_session(session_id)
        content = await self.read_short_term(session_id)
        budget_chars = max(1, int(max_chars or self.short_term_budget_chars))
        used_chars = len(content)
        remaining_chars = max(0, budget_chars - used_chars)
        remaining_ratio = max(0.0, min(1.0, remaining_chars / budget_chars))
        return ShortTermBudget(
            used_chars=used_chars,
            budget_chars=budget_chars,
            remaining_chars=remaining_chars,
            remaining_ratio=remaining_ratio,
            remaining_percent=int(round(remaining_ratio * 100)),
        )

    async def search_long_term_results(
        self,
        *,
        agent_id: str,
        query: str,
        limit: int = _DEFAULT_LONG_TERM_LIMIT,
        org_id: str | None = None,
        session_id: str | None = None,
        memory_type: str | None = None,
    ) -> list[dict[str, Any]]:
        if not self.client:
            return []
        session_id = self._enforce_bound_session(session_id)
        normalized_query = str(query or "").strip()
        if not normalized_query:
            return []
        try:
            result = await self.client.request(
                session_id="__memory__",
                method="memory_search",
                query=normalized_query,
                top_k=max(1, min(int(limit), 20)),
                agent_id=agent_id,
                org_id=org_id,
                target_session_id=session_id,
                memory_type=memory_type,
            )
        except Exception as exc:
            logger.warning("runtime_memory_search_failed", extra={"error": str(exc)})
            return []

        rows = result.get("results", []) if isinstance(result, dict) else []
        if not isinstance(rows, list):
            return []
        normalized: list[dict[str, Any]] = []
        for row in rows:
            if not isinstance(row, dict):
                continue
            content = str(row.get("content") or "").strip()
            if not content:
                continue
            normalized.append(
                {
                    "content": content,
                    "score": float(row.get("score") or 0.0),
                    "metadata": row.get("metadata") if isinstance(row.get("metadata"), dict) else {},
                }
            )
        return normalized

    async def search_long_term(
        self,
        *,
        agent_id: str,
        query: str,
        limit: int = _DEFAULT_LONG_TERM_LIMIT,
        org_id: str | None = None,
        session_id: str | None = None,
        memory_type: str | None = None,
    ) -> str:
        rows = await self.search_long_term_results(
            agent_id=agent_id,
            query=query,
            limit=limit,
            org_id=org_id,
            session_id=session_id,
            memory_type=memory_type,
        )
        return "\n\n".join(item["content"] for item in rows if str(item.get("content") or "").strip())

    async def save_long_term(
        self,
        *,
        agent_id: str,
        content: str,
        importance: float = 0.5,
        memory_type: str = "semantic",
        metadata: dict[str, Any] | None = None,
        org_id: str | None = None,
        session_id: str | None = None,
    ) -> None:
        del org_id
        if not self.client:
            return
        session_id = self._enforce_bound_session(session_id)
        normalized_content = str(content or "").strip()
        if not normalized_content:
            return
        try:
            await self.client.fire_and_forget(
                session_id="__memory__",
                method="memory_write",
                agent_id=agent_id,
                target_session_id=session_id,
                content=normalized_content,
                importance=max(0.0, min(1.0, float(importance))),
                memory_type=str(memory_type or "semantic").strip() or "semantic",
                metadata=metadata or {},
            )
            await self._emit_memory_long_term_written(
                session_id=session_id or self.bound_session_id or "",
                memory_type=str(memory_type or "semantic").strip() or "semantic",
                importance=max(0.0, min(1.0, float(importance))),
                content_preview=normalized_content,
            )
        except Exception as exc:
            logger.warning("runtime_memory_write_failed", extra={"error": str(exc)})

    async def build_memory_context(
        self,
        *,
        session_id: str,
        agent_id: str,
        query: str,
        org_id: str | None = None,
        long_term_limit: int = _DEFAULT_LONG_TERM_LIMIT,
    ) -> dict[str, Any]:
        session_id = self._enforce_bound_session(session_id)
        short_term = await self.read_short_term(session_id)
        budget = await self.get_short_term_budget(session_id)
        long_term_results = await self.search_long_term_results(
            agent_id=agent_id,
            query=query,
            limit=long_term_limit,
            org_id=org_id,
            session_id=session_id,
        )

        parts: list[str] = []
        if short_term.strip():
            parts.append(f"Recent context:\n{short_term.strip()}")
        if long_term_results:
            parts.append(
                "Relevant knowledge:\n"
                + "\n\n".join(str(item.get("content") or "").strip() for item in long_term_results if str(item.get("content") or "").strip())
            )
        return {
            "memory_context": "\n\n".join(parts).strip(),
            "short_term": short_term,
            "long_term_results": long_term_results,
            "budget": budget.to_dict(),
        }

    def prepare_memory_context(self, memory_context: str, *, max_chars: int) -> str:
        return prepare_memory_context_for_prompt(memory_context, max_chars=max_chars)

    def render_memory_snapshot(self, memory_snapshot: dict[str, Any] | None) -> str:
        return render_memory_snapshot(memory_snapshot)

    def prepare_memory_context_for_plan(self, memory_context: str, *, max_chars: int) -> str:
        return self.prepare_memory_context(memory_context, max_chars=max_chars)

    async def format_short_term_budget_prompt(
        self,
        session_id: str,
        *,
        max_chars: int | None = None,
    ) -> str:
        session_id = self._enforce_bound_session(session_id)
        budget = await self.get_short_term_budget(session_id, max_chars=max_chars)
        return (
            "Current short-term memory budget:\n"
            f"- used_chars={int(budget.used_chars or 0)}\n"
            f"- budget_chars={int(budget.budget_chars or 0)}\n"
            f"- remaining_percent={int(budget.remaining_percent or 0)}\n\n"
        )

    async def compact_short_term(
        self,
        *,
        session_id: str,
        target_chars: int | None = None,
        instructions: str | None = None,
        preserve_recent_turns: int = 2,
    ) -> dict[str, Any]:
        session_id = self._enforce_bound_session(session_id)
        original = await self.read_short_term(session_id)
        used_before = len(original)
        effective_target = max(1, int(target_chars or os.getenv("SEMIBOT_SHORT_TERM_COMPACT_TARGET_CHARS", str(_DEFAULT_SHORT_TERM_COMPACT_TARGET_CHARS))))
        if not original.strip() or used_before <= effective_target:
            return {
                "content": original,
                "compacted": False,
                "used_chars_before": used_before,
                "used_chars_after": used_before,
            }

        compacted = await self._compact_memory_text(
            original,
            target_chars=effective_target,
            instructions=instructions,
            preserve_recent_turns=preserve_recent_turns,
        )
        await self.replace_short_term(session_id, compacted)
        await self._emit_memory_short_term_compacted(
            session_id=session_id,
            used_chars_before=used_before,
            used_chars_after=len(compacted),
        )
        return {
            "content": compacted,
            "compacted": True,
            "used_chars_before": used_before,
            "used_chars_after": len(compacted),
        }

    async def maybe_auto_consolidate(
        self,
        *,
        session_id: str,
        agent_id: str,
        org_id: str | None = None,
        latest_user_message: str = "",
        latest_assistant_message: str = "",
        force: bool = False,
    ) -> dict[str, Any]:
        session_id = self._enforce_bound_session(session_id)
        budget = await self.get_short_term_budget(session_id)
        if not force and budget.remaining_ratio >= _AUTO_CONSOLIDATE_REMAINING_RATIO:
            return {
                "consolidated": False,
                "short_term_compacted": False,
                "long_term_written": 0,
            }

        source_before_compaction = await self.read_short_term(session_id)
        candidates = await self._extract_long_term_candidates(
            source_text=source_before_compaction,
            latest_user_message=latest_user_message,
            latest_assistant_message=latest_assistant_message,
        )
        long_term_written = 0
        for candidate in candidates:
            await self.save_long_term(
                agent_id=agent_id,
                content=str(candidate.get("content") or "").strip(),
                importance=float(candidate.get("importance") or 0.6),
                memory_type=str(candidate.get("memory_type") or "semantic"),
                metadata={
                    "source": "auto_consolidation",
                    "session_id": session_id,
                    **(candidate.get("metadata") if isinstance(candidate.get("metadata"), dict) else {}),
                },
                org_id=org_id,
                session_id=session_id,
            )
            long_term_written += 1
        compact_result = await self.compact_short_term(
            session_id=session_id,
            target_chars=max(1, int(self.short_term_budget_chars * 0.6)),
            preserve_recent_turns=2,
            instructions="Preserve user intent, completed work, important decisions, unresolved questions, and actionable preferences.",
        )
        return {
            "consolidated": bool(compact_result.get("compacted")) or long_term_written > 0,
            "short_term_compacted": bool(compact_result.get("compacted")),
            "long_term_written": long_term_written,
        }

    async def _compact_memory_text(
        self,
        source_text: str,
        *,
        target_chars: int,
        instructions: str | None,
        preserve_recent_turns: int,
    ) -> str:
        recent_blocks = [match.group(0).strip() for match in _TURN_BLOCK_REGEX.finditer(source_text)]
        kept_recent = "\n\n".join(recent_blocks[-preserve_recent_turns:]).strip() if recent_blocks else ""
        older_text = source_text
        if kept_recent and kept_recent in source_text:
            older_text = source_text[: source_text.rfind(kept_recent)].strip()
        llm_provider = self.llm_provider
        if llm_provider is not None and older_text.strip():
            bounded_text, truncated = _truncate_text(older_text, max(target_chars * 4, 4000))
            messages = [
                {
                    "role": "system",
                    "content": (
                        "You are a short-term memory compaction engine.\n"
                        "Compress the source text into a dense session summary.\n"
                        f"Keep the summary within about {max(300, target_chars // 2)} characters.\n"
                        "Preserve: user goals, completed work, important constraints, decisions, unresolved issues, and durable preferences.\n"
                        "Do not include markdown lists beyond what is necessary.\n"
                        "Return JSON only."
                    ),
                },
                {
                    "role": "user",
                    "content": json.dumps(
                        {
                            "instructions": instructions or "",
                            "text": bounded_text,
                            "truncated": truncated,
                        },
                        ensure_ascii=False,
                    ),
                },
            ]
            try:
                response = await llm_provider.chat(
                    messages=messages,
                    temperature=0,
                    model=self.act_model,
                    response_format={
                        "type": "json_schema",
                        "json_schema": {
                            "name": "short_term_memory_compaction",
                            "schema": {
                                "type": "object",
                                "properties": {
                                    "summary": {"type": "string"},
                                },
                                "required": ["summary"],
                                "additionalProperties": False,
                            },
                        },
                    },
                )
                payload = json.loads(str(response.content or "").strip())
                summary = str(payload.get("summary") or "").strip()
                if summary:
                    parts = [f"[memory_summary] {summary}"]
                    if kept_recent:
                        parts.append(kept_recent)
                    return "\n\n".join(parts).strip()[:target_chars]
            except Exception as exc:
                logger.warning("short_term_memory_compaction_failed", extra={"error": str(exc)})

        tail = (kept_recent or source_text[-max(80, target_chars // 2) :]).strip()
        summary_source = older_text or source_text
        head = summary_source[: max(60, target_chars // 3)].strip()
        if tail and len(tail) >= target_chars:
            return tail[-target_chars:]

        parts = []
        if tail:
            remaining_for_head = max(0, target_chars - len(tail) - (2 if head else 0))
            if head and remaining_for_head > len("[memory_summary] "):
                compact_head = head[: max(0, remaining_for_head - len("[memory_summary] "))].strip()
                if compact_head:
                    parts.append(f"[memory_summary] {compact_head}")
            parts.append(tail)
            return "\n\n".join(parts).strip()

        if head:
            return f"[memory_summary] {head[: max(0, target_chars - len('[memory_summary] '))].strip()}".strip()
        return source_text[-target_chars:]

    async def _extract_long_term_candidates(
        self,
        *,
        source_text: str,
        latest_user_message: str,
        latest_assistant_message: str,
    ) -> list[dict[str, Any]]:
        llm_provider = self.llm_provider
        if llm_provider is None or not str(source_text or "").strip():
            return []
        bounded_text, truncated = _truncate_text(source_text, 6000)
        messages = [
            {
                "role": "system",
                "content": (
                    "You are a memory consolidation engine.\n"
                    "Extract up to three durable long-term memory candidates.\n"
                    "Only keep stable facts, preferences, reusable procedures, or project decisions.\n"
                    "Ignore chatter, raw tool output, and transient execution noise.\n"
                    "Return JSON only."
                ),
            },
            {
                "role": "user",
                "content": json.dumps(
                    {
                        "source_text": bounded_text,
                        "truncated": truncated,
                        "latest_user_message": latest_user_message,
                        "latest_assistant_message": latest_assistant_message,
                    },
                    ensure_ascii=False,
                ),
            },
        ]
        try:
            response = await llm_provider.chat(
                messages=messages,
                temperature=0,
                model=self.act_model,
                response_format={
                    "type": "json_schema",
                    "json_schema": {
                        "name": "long_term_memory_candidates",
                        "schema": {
                            "type": "object",
                            "properties": {
                                "candidates": {
                                    "type": "array",
                                    "maxItems": 3,
                                    "items": {
                                        "type": "object",
                                        "properties": {
                                            "should_write": {"type": "boolean"},
                                            "content": {"type": "string"},
                                            "memory_type": {
                                                "type": "string",
                                                "enum": ["episodic", "semantic", "procedural"],
                                            },
                                            "importance": {"type": "number"},
                                            "metadata": {
                                                "type": "object",
                                                "additionalProperties": True,
                                            },
                                        },
                                        "required": ["should_write", "content", "memory_type", "importance"],
                                        "additionalProperties": False,
                                    },
                                },
                            },
                            "required": ["candidates"],
                            "additionalProperties": False,
                        },
                    },
                },
            )
            payload = json.loads(str(response.content or "").strip())
        except Exception as exc:
            logger.warning("long_term_memory_candidate_failed", extra={"error": str(exc)})
            return []

        if not isinstance(payload, dict):
            return []
        rows = payload.get("candidates")
        if not isinstance(rows, list):
            return []
        normalized: list[dict[str, Any]] = []
        for row in rows[:3]:
            if not isinstance(row, dict) or not bool(row.get("should_write")):
                continue
            content = str(row.get("content") or "").strip()
            if not content:
                continue
            normalized.append(
                {
                    "content": content,
                    "memory_type": str(row.get("memory_type") or "semantic"),
                    "importance": max(0.0, min(1.0, float(row.get("importance") or 0.6))),
                    "metadata": row.get("metadata") if isinstance(row.get("metadata"), dict) else {},
                }
            )
        return normalized
