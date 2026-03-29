from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

from src.execution.runtime_result import NormalizedExecutionResult


TerminalStatus = Literal["completed", "failed", "awaiting_approval"]
TerminalEventType = Literal["task.completed", "task.failed", "task.awaiting_approval"]


@dataclass
class TerminalExecutionResult:
    status: TerminalStatus
    event_type: TerminalEventType
    terminal_reason: str | None
    final_response: str
    awaiting_approval_message: str | None
    error: str | None
    pending_approval_ids: list[str]
    risk_hint: Literal["low", "medium", "high"]


def derive_terminal_execution_result(
    result: NormalizedExecutionResult,
) -> TerminalExecutionResult:
    if result.pending_approval_ids:
        return TerminalExecutionResult(
            status="awaiting_approval",
            event_type="task.awaiting_approval",
            terminal_reason=None,
            final_response=result.final_response,
            awaiting_approval_message=result.awaiting_approval_message,
            error=result.error,
            pending_approval_ids=list(result.pending_approval_ids),
            risk_hint="low",
        )

    failure_reason = result.terminal_failure_reason or result.error
    if failure_reason:
        return TerminalExecutionResult(
            status="failed",
            event_type="task.failed",
            terminal_reason=result.terminal_failure_reason or failure_reason,
            final_response=result.final_response,
            awaiting_approval_message=None,
            error=failure_reason,
            pending_approval_ids=[],
            risk_hint="medium",
        )

    return TerminalExecutionResult(
        status="completed",
        event_type="task.completed",
        terminal_reason="completed_normally",
        final_response=result.final_response,
        awaiting_approval_message=None,
        error=None,
        pending_approval_ids=[],
        risk_hint="low",
    )
