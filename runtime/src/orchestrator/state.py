"""Agent state type definitions for LangGraph orchestration."""

import os
import logging
from pathlib import Path
from datetime import datetime, timezone
from operator import add
from typing import Annotated, Any, Literal

from pydantic import BaseModel, Field
from typing_extensions import TypedDict
from zoneinfo import ZoneInfo

from src.orchestrator.context import RuntimeSessionContext


def _resolve_system_timezone_name() -> str:
    tz_env = str(os.getenv("TZ") or "").strip()
    if tz_env:
        return tz_env

    localtime_path = Path("/etc/localtime")
    if localtime_path.exists():
        try:
            resolved = localtime_path.resolve()
            resolved_str = str(resolved)
            marker = "/zoneinfo/"
            if marker in resolved_str:
                return resolved_str.split(marker, 1)[1].strip() or "UTC"
        except Exception:
            pass

    try:
        local_tz = datetime.now().astimezone().tzinfo
        if isinstance(local_tz, ZoneInfo):
            key = str(getattr(local_tz, "key", "") or "").strip()
            if key:
                return key
    except Exception:
        pass

    return "UTC"


def _resolve_effective_tzinfo(timezone_name: str) -> tuple[str, timezone | ZoneInfo]:
    try:
        return timezone_name, ZoneInfo(timezone_name)
    except Exception:
        logging.getLogger(__name__).warning(
            "Invalid timezone '%s', falling back to system timezone", timezone_name
        )
    system_timezone_name = _resolve_system_timezone_name()
    try:
        return system_timezone_name, ZoneInfo(system_timezone_name)
    except Exception:
        logging.getLogger(__name__).warning(
            "System timezone '%s' is invalid, falling back to UTC", system_timezone_name
        )
        return "UTC", timezone.utc


class StepInputRef(BaseModel):
    """Planner-declared reference to a prior step input source."""

    name: str = Field(..., description="Stable input name for this step")
    required: bool = Field(default=True, description="Whether this input is required")
    source_step_id: str | None = Field(
        default=None,
        description="Producer step id when this input depends on a prior step artifact",
    )
    preferred_medium: str = Field(
        default="artifact_result_text",
        description="Preferred handoff medium for this input",
    )
    fallback_medium: str | None = Field(
        default="artifact_result_path",
        description="Fallback medium when preferred medium is unavailable",
    )
    notes: str | None = Field(default=None, description="Optional planner note")


class StepOutputContract(BaseModel):
    """Machine-usable output contract for a plan step."""

    primary_output_kind: str = Field(
        default="text_output",
        description="Primary output semantic kind",
    )
    handoff_mode: str = Field(
        default="reasoning_text",
        description="How the next step should consume this output",
    )
    artifact_role: str = Field(
        default="text",
        description="Artifact role for the primary output",
    )
    must_produce_text: bool = Field(
        default=True,
        description="Whether this step must expose artifact_result_text",
    )
    must_materialize_file: bool = Field(
        default=False,
        description="Whether this step must write a file artifact",
    )
    file_format: str | None = Field(default=None, description="Required file format if any")
    handoff_purpose: str = Field(
        default="reasoning_continuation",
        description="Why downstream steps consume this output",
    )
    inferred: bool = Field(
        default=False,
        description="True when this contract was inferred from keywords rather than explicitly declared by the LLM",
    )


class MissingCapability(BaseModel):
    """Structured contract for capability gaps detected by planner or ACT."""

    type: Literal["missing_capability"] = "missing_capability"
    version: str = Field(default="1")
    intent: str = Field(..., description="Missing capability intent label")
    reason: str = Field(..., description="Why current tools cannot satisfy the step")
    required_capabilities: list[str] = Field(default_factory=list)
    preferred_sources: list[str] = Field(default_factory=list)


class PlanStep(BaseModel):
    """A single step in the execution plan."""

    id: str = Field(..., description="Unique step identifier", coerce_numbers_to_str=True)
    title: str = Field(..., description="Step title/description")
    phase: str | None = Field(default=None, description="Semantic phase label for this step")
    intent: str | None = Field(default=None, description="What this step is trying to achieve")
    inputs_required: list[str] = Field(
        default_factory=list,
        description="Inputs or dependencies required before executing this step",
    )
    expected_outputs: list[str] = Field(
        default_factory=list,
        description="Expected outputs/artifacts from this step",
    )
    execution_constraints: list[str] = Field(
        default_factory=list,
        description="Critical execution constraints for this semantic step",
    )
    completion_criteria: list[str] = Field(
        default_factory=list,
        description="Conditions that indicate the step is complete",
    )
    input_refs: list[StepInputRef] = Field(
        default_factory=list,
        description="Structured references for how this step depends on prior step outputs",
    )
    output_contract: StepOutputContract | None = Field(
        default=None,
        description="Structured contract for how this step should hand off outputs",
    )
    tool: str | None = Field(
        default=None,
        description="Internal execution-only field; not part of the planner step contract",
        exclude=True,
        repr=False,
    )
    capability_id: str | None = Field(
        default=None,
        description="Canonical executable capability identity used by runtime execution",
        exclude=True,
        repr=False,
    )
    params: dict[str, Any] = Field(
        default_factory=dict,
        description="Internal execution-only field; not part of the planner step contract",
        exclude=True,
        repr=False,
    )
    skill_source: str | None = Field(default=None, description="Skill id that guided this step")
    parallel: bool = Field(default=False, description="Whether this step can run in parallel")
    status: Literal["pending", "running", "completed", "failed"] = Field(default="pending")
    result: Any = Field(default=None, description="Step execution result")
    error: str | None = Field(default=None, description="Error message if failed")


class ExecutionPlan(BaseModel):
    """Execution plan generated by the planner."""

    plan_type: Literal["plan", "delegate", "terminate"] = Field(
        default="plan",
        description="Planner decision type",
    )
    goal: str = Field(..., description="The overall goal to achieve")
    steps: list[PlanStep] = Field(default_factory=list, description="List of steps to execute")
    current_step_index: int = Field(
        default=0,
        description="DEPRECATED — progress is tracked via pending_actions. Kept for checkpoint backward compat.",
    )
    plan_version: int = Field(
        default=1,
        description="Monotonic plan version for the current session",
    )
    selected_skill: str | None = Field(
        default=None,
        description="Primary skill selected for this planning round",
    )
    round_goal: str | None = Field(
        default=None,
        description="Round-level goal used by observe/reflect",
    )
    plan_mode: Literal["initial", "incremental_replan", "full_replan"] = Field(
        default="initial",
        description="Planning mode for this plan version",
    )
    planning_rationale: dict[str, Any] = Field(
        default_factory=dict,
        description="Structured planner rationale for why this plan was chosen",
    )
    skill_context_for_act: dict[str, Any] | None = Field(
        default=None,
        description="Planner-extracted structured skill guidance for ACT",
    )
    intent_decomposition: dict[str, Any] = Field(
        default_factory=dict,
        description="Structured decomposition of requested operation vs delivery goal",
    )
    final_delivery_contract: dict[str, Any] = Field(
        default_factory=dict,
        description="Structured final delivery contract for RESPOND",
    )
    current_date: str | None = Field(
        default=None,
        description="Session-scoped current date in YYYY-MM-DD",
    )
    current_weekday: str | None = Field(
        default=None,
        description="Session-scoped weekday label",
    )
    current_timezone: str | None = Field(
        default=None,
        description="Session-scoped timezone name",
    )
    stop_or_replan_conditions: list[str] = Field(
        default_factory=list,
        description="Conditions under which execution should stop or request replanning",
    )
    terminate_reason: str | None = Field(
        default=None,
        description="Termination reason when plan_type=terminate",
    )
    terminate_status: Literal["completed", "blocked", "no_further_action_needed"] | None = Field(
        default=None,
        description="Termination status when plan_type=terminate",
    )
    summary_for_act: str | None = Field(
        default=None,
        description="Termination summary passed to the unified response path",
    )
    user_reply: str | None = Field(
        default=None,
        description="User-facing natural language reply when plan_type=terminate",
    )
    sub_agent_id: str | None = Field(
        default=None,
        description="Sub-agent ID for full-task delegation when plan_type=delegate",
    )
    delegate_context: str | None = Field(
        default=None,
        description="Delegation context/payload when plan_type=delegate",
    )
    delegate_reason: str | None = Field(
        default=None,
        description="Why delegation was chosen for this round",
    )
    delegate_expected_outputs: list[str] = Field(
        default_factory=list,
        description="Expected outputs from delegated execution",
    )
    delegate_return_conditions: list[str] = Field(
        default_factory=list,
        description="Conditions under which delegated execution should return control",
    )


class Artifact(BaseModel):
    """Unified artifact output format.

    All skill/tool outputs should populate this structure.  Legacy paths
    (``metadata.generated_files``, ``result.artifact_result_text``, etc.)
    are still supported via a compatibility layer in ``nodes_stateflow``.
    """

    medium: Literal["file", "text", "structured"] = Field(
        ..., description="Artifact medium: file, text, or structured data"
    )
    # file artifact
    file_path: str | None = Field(default=None, description="Absolute file path")
    workspace_relative_path: str | None = Field(
        default=None, description="Workspace-relative path"
    )
    # text artifact
    text_content: str | None = Field(default=None, description="Text content")
    # common metadata
    artifact_name: str = Field(default="", description="Human-readable artifact name")
    artifact_role: str = Field(
        default="",
        description="Role: primary_output | intermediate | reference",
    )
    artifact_type: str = Field(
        default="",
        description="Type: report | code | data | text_output",
    )
    source_step_id: str | None = Field(
        default=None, description="Step that produced this artifact"
    )
    is_likely_final: bool = Field(
        default=False, description="Whether this is likely the final user deliverable"
    )


class ToolCallResult(BaseModel):
    """Result of a tool call execution."""

    tool_name: str
    capability_id: str | None = None
    params: dict[str, Any]
    result: Any = None
    error: str | None = None
    duration_ms: int = 0
    success: bool = True
    metadata: dict[str, Any] = Field(default_factory=dict)
    artifacts: list[Artifact] = Field(
        default_factory=list,
        description="Unified artifact list (new protocol). Legacy paths still supported.",
    )


class ReflectionResult(BaseModel):
    """Result of the reflection phase."""

    summary: str = Field(..., description="Summary of what was accomplished")
    lessons_learned: list[str] = Field(
        default_factory=list, description="Key lessons from this execution"
    )
    worth_remembering: bool = Field(
        default=False, description="Whether this should be stored in long-term memory"
    )
    importance: float = Field(
        default=0.5, ge=0.0, le=1.0, description="Importance score for memory storage"
    )


class Message(TypedDict):
    """A message in the conversation."""

    role: Literal["user", "assistant", "system", "tool"]
    content: str
    name: str | None
    tool_call_id: str | None


class DrPolicy(TypedDict, total=False):
    """Policy contract for Direct Reasoning Mode."""

    single_shot: bool
    allow_tools: bool
    allow_skills: bool
    max_tool_calls: int
    max_wall_clock_ms: int
    max_prompt_tokens: int
    max_react_iterations: int
    allow_parallel_tools: bool


class RoutingDecision(TypedDict, total=False):
    """Structured decision produced by ROUTE node."""

    mode: Literal["direct_answer", "direct_reasoning", "plan_act", "delegate"]
    goal: str
    reason: str
    delegate_to: str | None
    dr_policy: DrPolicy | None


class DirectReasoningResult(TypedDict, total=False):
    """Structured execution result produced by DR node."""

    status: Literal["completed", "partial", "upgrade_required", "failed"]
    answer: str | None
    artifacts: list[dict[str, Any]]
    tool_usage: dict[str, Any]
    evidence: list[dict[str, Any]]
    upgrade_reason: str | None
    failure: dict[str, Any] | None
    diagnostics: dict[str, Any]
    intermediate_context: dict[str, Any] | None
    resource_usage: dict[str, Any] | None


class DirectReasoningObserveOutcome(TypedDict, total=False):
    """Decision produced by OBSERVE_DR node."""

    outcome: Literal["respond_success", "respond_partial", "upgrade_to_plan_act", "awaiting_approval"]
    reason: str


class AgentState(TypedDict):
    """
    Agent execution state for LangGraph.

    This is the central state object that flows through all nodes in the state graph.
    Each node can read and update this state.

    Attributes:
        session_id: Unique session identifier for tracking
        agent_id: The agent being executed
        context: Runtime session context with agent config and capabilities
        messages: Conversation history (accumulates via reducer)
        current_step: Current state in the state machine
        plan: The execution plan generated by PLAN node
        pending_actions: Actions waiting to be executed
        tool_results: Results from tool executions (accumulates via reducer)
        memory_context: Rendered memory context string for prompt consumption
        memory_snapshot: Structured memory snapshot (short-term, long-term, budget)
        reflection: Reflection summary after task completion
        iteration: Current iteration count (for loop protection)
        error: Any error that occurred
        metadata: Additional metadata for tracking
    """

    # Identifiers
    session_id: str
    agent_id: str
    # Runtime context (NEW)
    context: "RuntimeSessionContext"

    # Conversation state - uses add reducer to accumulate messages
    messages: Annotated[list[Message], add]

    # State machine control
    current_step: Literal[
        "start",
        "route",
        "plan",
        "act",
        "dr",
        "delegate",
        "observe",
        "observe_dr",
        "reflect",
        "respond",
    ]
    execution_mode: Literal["direct_answer", "direct_reasoning", "plan_act", "delegate"] | None
    observe_outcome: (
        Literal[
            "task_completed",
            "continue_execution",
            "replan_current_round",
            "awaiting_approval",
        ]
        | None
    )
    observe_dr_outcome: DirectReasoningObserveOutcome | None

    # Planning state
    plan: ExecutionPlan | None
    routing_decision: RoutingDecision | None
    pending_actions: list[PlanStep]
    execution_state: dict[str, Any]
    dr_result: DirectReasoningResult | None

    # Execution state - uses add reducer to accumulate results
    tool_results: Annotated[list[ToolCallResult], add]

    # Memory state
    memory_context: str
    memory_snapshot: dict[str, Any]

    # Reflection state
    reflection: ReflectionResult | None

    # Control state
    iteration: int
    error: str | None

    # Metadata
    metadata: dict[str, Any]

    # Evolution state
    evolved_skill_refs: list[dict]
    evolution_triggered: bool


def _resolve_session_timezone(
    metadata: dict[str, Any] | None,
    context: RuntimeSessionContext | None,
) -> str:
    if isinstance(metadata, dict):
        for key in ("current_timezone", "user_timezone", "timezone"):
            value = str(metadata.get(key) or "").strip()
            if value:
                return value
    runtime_metadata = getattr(context, "metadata", None)
    if isinstance(runtime_metadata, dict):
        for key in ("current_timezone", "user_timezone", "timezone"):
            value = str(runtime_metadata.get(key) or "").strip()
            if value:
                return value
    return _resolve_system_timezone_name()


def build_session_time_metadata(
    metadata: dict[str, Any] | None = None,
    context: RuntimeSessionContext | None = None,
) -> dict[str, Any]:
    merged = dict(metadata or {})
    timezone_name = _resolve_session_timezone(merged, context)
    timezone_name, tzinfo = _resolve_effective_tzinfo(timezone_name)
    now = datetime.now(tzinfo)
    merged.setdefault("current_date", now.strftime("%Y-%m-%d"))
    merged.setdefault("current_weekday", now.strftime("%A"))
    merged.setdefault("current_timezone", timezone_name)
    return merged


def resolve_time_context(
    metadata: dict[str, Any] | None = None,
    plan: ExecutionPlan | None = None,
    *,
    prefer_plan: bool = False,
) -> tuple[str, str, str]:
    metadata_map = build_session_time_metadata(metadata)
    current_date = str(metadata_map.get("current_date") or "").strip()
    current_weekday = str(metadata_map.get("current_weekday") or "").strip()
    current_timezone = str(metadata_map.get("current_timezone") or "").strip()
    if isinstance(plan, ExecutionPlan):
        plan_date = str(plan.current_date or "").strip()
        plan_weekday = str(plan.current_weekday or "").strip()
        plan_timezone = str(plan.current_timezone or "").strip()
        if prefer_plan and plan_date:
            current_date = plan_date
            current_weekday = plan_weekday or current_weekday
            current_timezone = plan_timezone or current_timezone
        else:
            current_date = plan_date or current_date
            current_weekday = plan_weekday or current_weekday
            current_timezone = plan_timezone or current_timezone
    return current_date, current_weekday, current_timezone


def create_initial_state(
    session_id: str,
    agent_id: str,
    user_message: str,
    context: RuntimeSessionContext,
    history_messages: list[dict[str, str]] | None = None,
    metadata: dict[str, Any] | None = None,
) -> AgentState:
    """
    Create an initial agent state for a new execution.

    Args:
        session_id: Unique session identifier
        agent_id: The agent to execute
        user_message: The user's input message
        context: Runtime session context with agent config and capabilities
        history_messages: Optional full conversation history from API layer
        metadata: Optional additional metadata

    Returns:
        A properly initialized AgentState
    """
    if history_messages:
        normalized_messages: list[Message] = []
        for msg in history_messages:
            role = msg.get("role")
            content = msg.get("content")
            if role in ("user", "assistant") and isinstance(content, str):
                normalized_messages.append(
                    Message(role=role, content=content, name=None, tool_call_id=None)
                )
        if not normalized_messages or normalized_messages[-1]["role"] != "user" or normalized_messages[-1]["content"] != user_message:
            normalized_messages.append(
                Message(role="user", content=user_message, name=None, tool_call_id=None)
            )
        initial_messages = normalized_messages
    else:
        initial_messages = [
            Message(role="user", content=user_message, name=None, tool_call_id=None)
        ]

    initial_metadata = build_session_time_metadata(metadata, context)

    return AgentState(
        session_id=session_id,
        agent_id=agent_id,
        context=context,
        messages=initial_messages,
        current_step="start",
        execution_mode=None,
        observe_outcome=None,
        observe_dr_outcome=None,
        plan=None,
        routing_decision=None,
        pending_actions=[],
        execution_state={
            "completed_steps": [],
            "in_progress_steps": [],
            "failed_steps": [],
            "observations": [],
            "artifacts_produced": [],
            "unresolved_questions": [],
            "known_constraints": [],
            "remaining_budget_or_limits": [],
            "step_input_bindings": {},
        },
        dr_result=None,
        tool_results=[],
        memory_context="",
        memory_snapshot={
            "memory_context": "",
            "short_term": "",
            "long_term_results": [],
            "budget": {
                "used_chars": 0,
                "budget_chars": 12000,
                "remaining_chars": 12000,
                "remaining_ratio": 1.0,
                "remaining_percent": 100,
            },
        },
        reflection=None,
        iteration=0,
        error=None,
        metadata=initial_metadata,
        evolved_skill_refs=[],
        evolution_triggered=False,
    )
