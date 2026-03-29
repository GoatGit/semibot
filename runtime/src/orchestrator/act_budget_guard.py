"""Budget guard for ACT loop retries, tool budgets, time, and token tracking."""

from __future__ import annotations

import os
import time
from typing import Any

from src.orchestrator.runtime_middleware import RuntimeSignal, StepRuntimeBudgetState

_MAX_TOTAL_TOKENS_PER_STEP = int(os.getenv("SEMIBOT_ACT_MAX_TOTAL_TOKENS_PER_STEP") or "0")
_MAX_WALL_CLOCK_SECONDS = float(os.getenv("SEMIBOT_ACT_MAX_WALL_CLOCK_SECONDS") or "0")


def resolve_step_budget_limits(*, max_tool_calls_per_step: int, max_inner_turns: int) -> dict[str, Any]:
    return {
        "max_tool_calls_per_step": int(max_tool_calls_per_step),
        "max_inner_turns": int(max_inner_turns),
        "max_total_tokens": _MAX_TOTAL_TOKENS_PER_STEP,
        "max_wall_clock_seconds": _MAX_WALL_CLOCK_SECONDS,
    }


def check_pre_llm_budget(budget: StepRuntimeBudgetState) -> RuntimeSignal:
    elapsed = time.monotonic() - budget.started_at_monotonic
    if budget.max_wall_clock_seconds > 0 and elapsed > budget.max_wall_clock_seconds:
        return RuntimeSignal(
            kind="hard_stop",
            source="budget_guard",
            reason="wall_clock_budget_exceeded",
            message=f"ACT step exceeded wall-clock budget of {budget.max_wall_clock_seconds:.1f}s",
            data={"elapsed_seconds": elapsed},
        )
    if budget.max_total_tokens > 0 and budget.total_tokens >= budget.max_total_tokens:
        return RuntimeSignal(
            kind="hard_stop",
            source="budget_guard",
            reason="token_budget_exceeded",
            message=f"ACT step exceeded total token budget of {budget.max_total_tokens}",
            data={"total_tokens": budget.total_tokens},
        )
    if budget.llm_call_count >= budget.max_inner_turns:
        return RuntimeSignal(
            kind="hard_stop",
            source="budget_guard",
            reason="inner_turn_budget_exceeded",
            message=f"ACT step exceeded {budget.max_inner_turns} LLM decision turns",
            data={"llm_call_count": budget.llm_call_count},
        )
    return RuntimeSignal(kind="allow", source="budget_guard", reason="within_budget")


def check_pre_tool_budget(budget: StepRuntimeBudgetState, requested_calls: int) -> RuntimeSignal:
    remaining_budget = budget.max_tool_calls_per_step - budget.tool_call_count
    if remaining_budget <= 0:
        return RuntimeSignal(
            kind="hard_stop",
            source="budget_guard",
            reason="tool_budget_exceeded",
            message=f"ACT step exceeded {budget.max_tool_calls_per_step} tool calls",
            data={
                "tool_call_count": budget.tool_call_count,
                "requested_tool_calls": requested_calls,
            },
        )
    if requested_calls > remaining_budget:
        return RuntimeSignal(
            kind="warn",
            source="budget_guard",
            reason="tool_budget_will_truncate",
            message="Tool call batch exceeds remaining tool-call budget and will be truncated",
            data={"remaining_budget": remaining_budget, "requested_tool_calls": requested_calls},
        )
    return RuntimeSignal(kind="allow", source="budget_guard", reason="within_tool_budget")


def reconcile_llm_usage(budget: StepRuntimeBudgetState, usage: dict[str, Any] | None) -> RuntimeSignal:
    usage_payload = dict(usage or {})
    budget.prompt_tokens += int(usage_payload.get("prompt_tokens") or 0)
    budget.completion_tokens += int(usage_payload.get("completion_tokens") or 0)
    budget.total_tokens += int(usage_payload.get("total_tokens") or 0)
    budget.last_usage = usage_payload
    if budget.max_total_tokens > 0 and budget.total_tokens >= budget.max_total_tokens:
        return RuntimeSignal(
            kind="hard_stop",
            source="budget_guard",
            reason="token_budget_exceeded",
            message=f"ACT step exceeded total token budget of {budget.max_total_tokens}",
            data={"total_tokens": budget.total_tokens},
        )
    return RuntimeSignal(kind="emit_only", source="budget_guard", reason="usage_reconciled", data=usage_payload)
