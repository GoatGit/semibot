"""Context compression middleware for ACT message assembly."""

from __future__ import annotations

from typing import Any

from src.orchestrator.context_budget import get_act_budget
from src.orchestrator.runtime_middleware import RuntimeSignal


def apply_context_compression(
    *,
    act_phase: str,
    original_transcript_len: int,
    compact_transcript_len: int,
    original_artifact_count: int,
    compact_artifact_count: int,
    last_runtime_signal: dict[str, Any] | None = None,
) -> tuple[list[dict[str, Any]], RuntimeSignal | None]:
    budget = get_act_budget(act_phase)
    reminders: list[dict[str, Any]] = []
    compressed = (
        compact_transcript_len < original_transcript_len
        or compact_artifact_count < original_artifact_count
    )
    if compressed:
        reminders.append(
            {
                "role": "system",
                "content": (
                    "Context compression is active for this ACT turn. Prioritize the current step contract, "
                    "latest tool evidence, latest artifact context, and explicit must-fix constraints."
                )[: budget.max_history_per_message_chars],
            }
        )
    if isinstance(last_runtime_signal, dict):
        reason = str(last_runtime_signal.get("reason") or "").strip()
        message = str(last_runtime_signal.get("message") or "").strip()
        if reason or message:
            reminders.append(
                {
                    "role": "system",
                    "content": (
                        f"Runtime reminder: {message or reason}. "
                        "Do not repeat the same blocked or warned strategy."
                    )[: budget.max_history_per_message_chars],
                }
            )
    if not compressed:
        return reminders, None
    return reminders, RuntimeSignal(
        kind="emit_only",
        source="context_compression",
        reason="context_compacted",
        message="ACT context was compacted before the LLM call",
        data={
            "original_transcript_len": original_transcript_len,
            "compact_transcript_len": compact_transcript_len,
            "original_artifact_count": original_artifact_count,
            "compact_artifact_count": compact_artifact_count,
        },
    )
