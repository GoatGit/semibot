"""Provider compatibility helpers used by orchestrator nodes."""

from dataclasses import dataclass
from typing import Any

from src.llm.provider_capabilities import ProviderCapabilities, resolve_provider_capabilities


@dataclass(frozen=True)
class ActExecutionStrategy:
    """Strategy flags for ACT node execution."""

    two_phase: bool
    tool_phase_response_format: dict[str, Any] | None
    terminal_phase_response_format: dict[str, Any] | None  # None = use system-prompt hint


@dataclass(frozen=True)
class PlanExecutionStrategy:
    """Strategy flags for PLAN node execution."""

    two_phase: bool
    tool_phase_response_format: dict[str, Any] | None
    terminal_phase_response_format: dict[str, Any] | None  # None = use system-prompt hint


def _downgrade_response_format(
    response_format: dict[str, Any],
    caps: ProviderCapabilities,
) -> dict[str, Any] | None:
    """
    Downgrade or suppress response_format based on provider capabilities.

    - If provider doesn't support the response_format param at all, return None
      (caller should use system-prompt JSON hint instead).
    - If provider doesn't support json_schema, downgrade to json_object.
    - Otherwise return as-is.
    """
    if not caps.supports_response_format_param:
        return None
    if caps.supports_json_schema_response_format:
        return response_format
    if response_format.get("type") == "json_schema":
        return {"type": "json_object"}
    return response_format


def resolve_act_execution_strategy(
    *,
    llm_provider: Any,
    model: str | None,
    terminal_response_format: dict[str, Any],
) -> ActExecutionStrategy:
    """
    Resolve how ACT should call the model for the current provider/model.

    ACT now always uses a two-phase structure:
    - tool phase: tools enabled, no strict response_format
    - terminal phase: tools disabled, strict terminal JSON

    Provider capabilities still control how strict the terminal response_format
    can be (json_schema vs json_object downgrade).
    """

    caps: ProviderCapabilities = resolve_provider_capabilities(
        llm_provider=llm_provider,
        model=model,
    )
    effective_terminal_fmt = _downgrade_response_format(terminal_response_format, caps)
    return ActExecutionStrategy(
        two_phase=True,
        tool_phase_response_format=None,
        terminal_phase_response_format=effective_terminal_fmt,
    )


def resolve_plan_execution_strategy(
    *,
    llm_provider: Any,
    model: str | None,
    terminal_response_format: dict[str, Any],
) -> PlanExecutionStrategy:
    """
    Resolve how PLAN should call the model for the current provider/model.

    PLAN now always uses a two-phase structure:
    - tool phase: tools enabled, no strict response_format
    - terminal phase: tools disabled, strict final JSON

    Provider capabilities still control how strict the terminal response_format
    can be (json_schema vs json_object downgrade).
    """

    caps: ProviderCapabilities = resolve_provider_capabilities(
        llm_provider=llm_provider,
        model=model,
    )
    effective_terminal_fmt = _downgrade_response_format(terminal_response_format, caps)
    return PlanExecutionStrategy(
        two_phase=True,
        tool_phase_response_format=None,
        terminal_phase_response_format=effective_terminal_fmt,
    )
