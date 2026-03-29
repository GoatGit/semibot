"""Shared runtime middleware contracts and step-scoped state helpers."""

from __future__ import annotations

import time
from dataclasses import asdict, dataclass, field
from typing import Any, Literal

from src.orchestrator.state import AgentState

RuntimeSignalKind = Literal["allow", "warn", "block", "hard_stop", "terminal", "retry", "emit_only"]
RuntimeFailureFamily = Literal["llm", "tool", "runtime"]


@dataclass(slots=True)
class RuntimeSignal:
    kind: RuntimeSignalKind
    source: str
    reason: str
    message: str = ""
    data: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(slots=True)
class RuntimeFailure:
    family: RuntimeFailureFamily
    kind: str
    retryable: bool
    source: str
    message: str
    meta: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(slots=True)
class StepRuntimeBudgetState:
    step_id: str
    iteration: int
    started_at_monotonic: float
    llm_call_count: int = 0
    tool_call_count: int = 0
    terminal_retry_count: int = 0
    rate_limit_retry_count: int = 0
    context_overflow_retry_count: int = 0
    timeout_retry_count: int = 0
    output_truncation_retry_count: int = 0
    prompt_tokens: int = 0
    completion_tokens: int = 0
    total_tokens: int = 0
    last_usage: dict[str, Any] = field(default_factory=dict)
    max_tool_calls_per_step: int = 0
    max_inner_turns: int = 0
    max_wall_clock_seconds: float = 0.0
    max_total_tokens: int = 0

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def ensure_step_runtime_state(state: AgentState, step_id: str, iteration: int) -> dict[str, Any]:
    metadata = state.setdefault("metadata", {})
    runtime_meta = metadata.setdefault("runtime_middleware", {})
    steps = runtime_meta.setdefault("steps", {})
    step_key = f"{str(step_id)}@iter:{int(iteration)}"
    step_state = steps.setdefault(
        step_key,
        {
            "step_key": step_key,
            "step_id": step_id,
            "iteration": int(iteration),
            "signals": [],
            "failures": [],
            "budget": {},
            "loop_guard": {
                "repeat_count_by_hash": {},
                "failure_repeat_count_by_hash": {},
                "warned_hashes": [],
                "blocked_hashes": [],
                "hard_stopped_hashes": [],
                "last_loop_signal": None,
            },
            "usage": {
                "llm_call_count": 0,
                "prompt_tokens": 0,
                "completion_tokens": 0,
                "total_tokens": 0,
                "duration_ms": 0,
            },
            "heartbeat": {
                "last_emit_monotonic": 0.0,
                "count": 0,
            },
        },
    )
    step_state["iteration"] = int(iteration)
    step_state.setdefault("signals", [])
    step_state.setdefault("failures", [])
    step_state.setdefault("budget", {})
    step_state.setdefault("loop_guard", {})
    step_state.setdefault("usage", {})
    step_state.setdefault("heartbeat", {})
    step_state["last_updated_monotonic"] = time.monotonic()
    latest_step_keys = runtime_meta.setdefault("latest_step_keys", {})
    latest_step_keys[str(step_id)] = step_key
    return step_state


def get_step_runtime_state(state: AgentState, step_id: str, iteration: int) -> dict[str, Any]:
    runtime_meta = ((state.get("metadata") or {}).get("runtime_middleware") or {})
    steps = runtime_meta.get("steps") or {}
    return dict(steps.get(f"{str(step_id)}@iter:{int(iteration)}") or {})


def append_runtime_signal(state: AgentState, step_id: str, iteration: int, signal: RuntimeSignal) -> None:
    step_state = ensure_step_runtime_state(state, step_id, iteration)
    signals = step_state.setdefault("signals", [])
    signals.append(signal.to_dict())
    if len(signals) > 50:
        del signals[:-50]


def append_runtime_failure(state: AgentState, step_id: str, iteration: int, failure: RuntimeFailure) -> None:
    step_state = ensure_step_runtime_state(state, step_id, iteration)
    failures = step_state.setdefault("failures", [])
    failures.append(failure.to_dict())
    if len(failures) > 50:
        del failures[:-50]


async def emit_runtime_signal_event(
    event_emitter: Any | None,
    *,
    state: AgentState,
    step_id: str,
    iteration: int,
    signal: RuntimeSignal,
) -> None:
    if event_emitter is None:
        return
    await event_emitter.emit(
        "runtime.signal",
        {
            "session_id": state["session_id"],
            "agent_id": state.get("agent_id"),
            "step_id": step_id,
            "iteration": iteration,
            **signal.to_dict(),
        },
    )


async def emit_runtime_failure_event(
    event_emitter: Any | None,
    *,
    state: AgentState,
    step_id: str,
    iteration: int,
    failure: RuntimeFailure,
) -> None:
    if event_emitter is None:
        return
    await event_emitter.emit(
        "runtime.failure",
        {
            "session_id": state["session_id"],
            "agent_id": state.get("agent_id"),
            "step_id": step_id,
            "iteration": iteration,
            **failure.to_dict(),
        },
    )


def load_budget_state(
    state: AgentState,
    *,
    step_id: str,
    iteration: int,
    max_tool_calls_per_step: int,
    max_inner_turns: int,
    max_wall_clock_seconds: float,
    max_total_tokens: int,
) -> StepRuntimeBudgetState:
    step_state = ensure_step_runtime_state(state, step_id, iteration)
    raw_budget = step_state.setdefault("budget", {})
    started_at_monotonic = float(raw_budget.get("started_at_monotonic") or time.monotonic())
    budget = StepRuntimeBudgetState(
        step_id=step_id,
        iteration=int(iteration),
        started_at_monotonic=started_at_monotonic,
        llm_call_count=int(raw_budget.get("llm_call_count") or 0),
        tool_call_count=int(raw_budget.get("tool_call_count") or 0),
        terminal_retry_count=int(raw_budget.get("terminal_retry_count") or 0),
        rate_limit_retry_count=int(raw_budget.get("rate_limit_retry_count") or 0),
        context_overflow_retry_count=int(raw_budget.get("context_overflow_retry_count") or 0),
        timeout_retry_count=int(raw_budget.get("timeout_retry_count") or 0),
        output_truncation_retry_count=int(raw_budget.get("output_truncation_retry_count") or 0),
        prompt_tokens=int(raw_budget.get("prompt_tokens") or 0),
        completion_tokens=int(raw_budget.get("completion_tokens") or 0),
        total_tokens=int(raw_budget.get("total_tokens") or 0),
        last_usage=dict(raw_budget.get("last_usage") or {}),
        max_tool_calls_per_step=max_tool_calls_per_step,
        max_inner_turns=max_inner_turns,
        max_wall_clock_seconds=max_wall_clock_seconds,
        max_total_tokens=max_total_tokens,
    )
    persist_budget_state(state, step_id, iteration, budget)
    return budget


def persist_budget_state(state: AgentState, step_id: str, iteration: int, budget: StepRuntimeBudgetState) -> None:
    step_state = ensure_step_runtime_state(state, step_id, iteration)
    step_state["budget"] = budget.to_dict()
