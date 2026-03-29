"""LLM usage tracking for ACT runtime middleware."""

from __future__ import annotations

from typing import Any

from src.orchestrator.runtime_middleware import StepRuntimeBudgetState, ensure_step_runtime_state
from src.orchestrator.state import AgentState


def record_llm_usage(
    *,
    state: AgentState,
    step_id: str,
    iteration: int,
    usage: dict[str, Any] | None,
    duration_ms: int,
    model: str | None,
) -> dict[str, Any]:
    step_state = ensure_step_runtime_state(state, step_id, iteration)
    usage_state = step_state.setdefault("usage", {})
    usage_payload = dict(usage or {})
    usage_state["llm_call_count"] = int(usage_state.get("llm_call_count") or 0) + 1
    usage_state["prompt_tokens"] = int(usage_state.get("prompt_tokens") or 0) + int(usage_payload.get("prompt_tokens") or 0)
    usage_state["completion_tokens"] = int(usage_state.get("completion_tokens") or 0) + int(usage_payload.get("completion_tokens") or 0)
    usage_state["total_tokens"] = int(usage_state.get("total_tokens") or 0) + int(usage_payload.get("total_tokens") or 0)
    usage_state["duration_ms"] = int(usage_state.get("duration_ms") or 0) + int(duration_ms or 0)
    usage_state["last_model"] = model or usage_state.get("last_model")
    usage_state["last_usage"] = usage_payload
    return usage_state


def sync_budget_from_usage(budget: StepRuntimeBudgetState, usage_state: dict[str, Any]) -> None:
    budget.llm_call_count = int(usage_state.get("llm_call_count") or budget.llm_call_count)
    budget.prompt_tokens = int(usage_state.get("prompt_tokens") or budget.prompt_tokens)
    budget.completion_tokens = int(usage_state.get("completion_tokens") or budget.completion_tokens)
    budget.total_tokens = int(usage_state.get("total_tokens") or budget.total_tokens)
    budget.last_usage = dict(usage_state.get("last_usage") or budget.last_usage)
