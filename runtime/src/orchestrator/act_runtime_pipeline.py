"""Explicit ACT runtime middleware pipeline."""

from __future__ import annotations

from typing import Any

from src.orchestrator.act_budget_guard import (
    check_pre_llm_budget,
    check_pre_tool_budget,
    reconcile_llm_usage,
)
from src.orchestrator.act_heartbeat import maybe_emit_act_heartbeat
from src.orchestrator.act_usage_tracking import record_llm_usage, sync_budget_from_usage
from src.orchestrator.runtime_middleware import (
    RuntimeFailure,
    RuntimeSignal,
    StepRuntimeBudgetState,
    append_runtime_failure,
    append_runtime_signal,
    emit_runtime_failure_event,
    emit_runtime_signal_event,
    persist_budget_state,
)
from src.orchestrator.state import AgentState, PlanStep


class ActRuntimePipeline:
    def __init__(
        self,
        *,
        state: AgentState,
        action: PlanStep,
        iteration: int,
        event_emitter: Any | None,
        budget: StepRuntimeBudgetState,
    ) -> None:
        self.state = state
        self.action = action
        self.iteration = int(iteration)
        self.event_emitter = event_emitter
        self.budget = budget

    def snapshot_counters(
        self,
        *,
        tool_call_count: int,
        terminal_retry_count: int,
        rate_limit_retry_count: int,
        context_overflow_retry_count: int,
        timeout_retry_count: int,
        output_truncation_retry_count: int,
    ) -> None:
        self.budget.tool_call_count = tool_call_count
        self.budget.terminal_retry_count = terminal_retry_count
        self.budget.rate_limit_retry_count = rate_limit_retry_count
        self.budget.context_overflow_retry_count = context_overflow_retry_count
        self.budget.timeout_retry_count = timeout_retry_count
        self.budget.output_truncation_retry_count = output_truncation_retry_count
        persist_budget_state(self.state, self.action.id, self.iteration, self.budget)

    async def on_tick(self, *, act_phase: str, turn_count: int) -> None:
        await maybe_emit_act_heartbeat(
            state=self.state,
            action_id=self.action.id,
            iteration=self.iteration,
            act_phase=act_phase,
            event_emitter=self.event_emitter,
            turn_count=turn_count,
        )

    async def pre_llm_call(self) -> RuntimeSignal:
        signal = check_pre_llm_budget(self.budget)
        if signal.kind != "allow":
            await self.emit_signal(signal)
        return signal

    async def on_context_signal(self, signal: RuntimeSignal | None) -> None:
        if signal is not None:
            await self.emit_signal(signal)

    async def on_llm_error(self, runtime_failure: RuntimeFailure | None, runtime_signal: RuntimeSignal | None) -> None:
        if runtime_failure is not None:
            await self.emit_failure(runtime_failure)
        if runtime_signal is not None:
            await self.emit_signal(runtime_signal)

    async def post_llm_usage(self, *, usage: dict[str, Any] | None, duration_ms: int, model: str | None) -> RuntimeSignal:
        usage_state = record_llm_usage(
            state=self.state,
            step_id=self.action.id,
            iteration=self.iteration,
            usage=usage,
            duration_ms=duration_ms,
            model=model,
        )
        signal = reconcile_llm_usage(self.budget, usage)
        sync_budget_from_usage(self.budget, usage_state)
        persist_budget_state(self.state, self.action.id, self.iteration, self.budget)
        if signal.kind != "allow":
            await self.emit_signal(signal)
        return signal

    async def pre_tool_batch(self, *, requested_calls: int) -> RuntimeSignal:
        signal = check_pre_tool_budget(self.budget, requested_calls)
        if signal.kind != "allow":
            await self.emit_signal(signal)
        return signal

    async def emit_signal(self, signal: RuntimeSignal) -> None:
        append_runtime_signal(self.state, self.action.id, self.iteration, signal)
        await emit_runtime_signal_event(
            self.event_emitter,
            state=self.state,
            step_id=self.action.id,
            iteration=self.iteration,
            signal=signal,
        )

    async def emit_failure(self, failure: RuntimeFailure) -> None:
        append_runtime_failure(self.state, self.action.id, self.iteration, failure)
        await emit_runtime_failure_event(
            self.event_emitter,
            state=self.state,
            step_id=self.action.id,
            iteration=self.iteration,
            failure=failure,
        )
