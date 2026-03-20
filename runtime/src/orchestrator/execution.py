"""Shared parsing and failure utilities for agents and orchestrator nodes."""

from typing import Any

from src.utils.logging import get_logger

from src.orchestrator.state import (
    ExecutionPlan,
    PlanStep,
    ReflectionResult,
    StepInputRef,
    StepOutputContract,
    ToolCallResult,
)

logger = get_logger(__name__)


def parse_plan_response(response: dict[str, Any]) -> ExecutionPlan:
    """
    Parse an LLM plan response into an ExecutionPlan.

    Args:
        response: The LLM response dict containing goal, steps, etc.

    Returns:
        Parsed ExecutionPlan object
    """
    # Handle direct response format, content wrapper format, and single-key wrappers
    # like {"plan": {...}} / {"delegate": {...}} / {"terminate": {...}}.
    content = response.get("content", response) if isinstance(response.get("content"), dict) else response
    if isinstance(content, dict):
        wrapped_payload = None
        wrapped_type = None
        for candidate_type in ("plan", "delegate", "terminate"):
            value = content.get(candidate_type)
            if isinstance(value, dict):
                wrapped_payload = value
                wrapped_type = candidate_type
                break
            elif candidate_type == "plan" and isinstance(value, list):
                # Handle the case where plan is given directly as an array of steps
                wrapped_payload = {"steps": value}
                wrapped_type = "plan"
                break
        
        if wrapped_payload is not None:
            content = {
                **wrapped_payload,
                "type": str(wrapped_payload.get("type") or wrapped_type),
            }

    def _list_of_strings(value: Any) -> list[str]:
        if not isinstance(value, list):
            return []
        rows: list[str] = []
        for item in value:
            text = str(item or "").strip()
            if text:
                rows.append(text)
        return rows

    raw_steps = content.get("steps")
    if not isinstance(raw_steps, list):
        raw_steps = []
    if not raw_steps and isinstance(content.get("phases"), list):
        phase_steps: list[dict[str, Any]] = []
        for phase in content.get("phases", []):
            if not isinstance(phase, dict):
                continue
            phase_name = str(phase.get("name") or phase.get("phase") or "").strip()
            for step in phase.get("steps", []):
                if not isinstance(step, dict):
                    continue
                normalized_step = dict(step)
                if phase_name and not str(normalized_step.get("phase") or "").strip():
                    normalized_step["phase"] = phase_name
                phase_steps.append(normalized_step)
        raw_steps = phase_steps

    # Parse semantic plan steps. Planner v2 should not bind execution details here.
    def _parse_input_refs(step: dict[str, Any]) -> list[StepInputRef]:
        value = step.get("input_refs")
        if value is None:
            value = step.get("input_contract")
        if not isinstance(value, list):
            return []
        rows: list[StepInputRef] = []
        for item in value:
            if not isinstance(item, dict):
                continue
            normalized = dict(item)
            normalized.pop("artifact_role", None)
            normalized.pop("source_type", None)
            try:
                rows.append(StepInputRef(**normalized))
            except Exception as exc:
                logger.warning("_parse_input_refs: failed to parse StepInputRef", extra={"item": item, "error": str(exc)})
                continue
        return rows

    def _parse_output_contract(step: dict[str, Any]) -> StepOutputContract | None:
        value = step.get("output_contract")
        if isinstance(value, dict):
            try:
                return StepOutputContract(**value)
            except Exception as exc:
                logger.warning("_parse_output_contract: failed to parse StepOutputContract", extra={"value": value, "error": str(exc)})
        return None

    def _infer_output_contract(step: dict[str, Any]) -> StepOutputContract:
        haystack = " ".join(
            str(step.get(key) or "")
            for key in ("phase", "title", "intent")
        ).lower()
        expected = " ".join(_list_of_strings(step.get("expected_outputs"))).lower()
        if any(token in haystack or token in expected for token in ("report", "报告")):
            return StepOutputContract(
                primary_output_kind="report_markdown",
                handoff_mode="reasoning_text",
                artifact_role="report_md",
                must_produce_text=True,
                must_materialize_file=False,
                file_format="md",
                handoff_purpose="user_delivery",
                inferred=True,
            )
        if any(token in haystack or token in expected for token in ("search", "retrieve", "检索", "证据")):
            return StepOutputContract(
                primary_output_kind="evidence_bundle",
                handoff_mode="reasoning_text",
                artifact_role="evidence_bundle",
                must_produce_text=True,
                must_materialize_file=False,
                handoff_purpose="reasoning_continuation",
                inferred=True,
            )
        return StepOutputContract(
            primary_output_kind="text_output",
            handoff_mode="reasoning_text",
            artifact_role="text",
            must_produce_text=True,
            must_materialize_file=False,
            handoff_purpose="reasoning_continuation",
            inferred=True,
        )

    def _infer_delivery_goal_from_steps(
        content_dict: dict[str, Any],
        steps_value: list[PlanStep],
    ) -> str:
        for step in reversed(steps_value):
            expected_outputs = [str(item or "").strip() for item in (step.expected_outputs or []) if str(item or "").strip()]
            if expected_outputs:
                return expected_outputs[0]
        for step in reversed(steps_value):
            title = str(step.title or "").strip()
            if title:
                return title
        return str(content_dict.get("goal") or "").strip() or "final deliverable"

    def _infer_final_delivery_contract(content_dict: dict[str, Any], steps_value: list[PlanStep]) -> dict[str, Any]:
        explicit = content_dict.get("final_delivery_contract")
        if isinstance(explicit, dict):
            return explicit
        inferred_delivery_goal = _infer_delivery_goal_from_steps(content_dict, steps_value)
        return {
            "delivery_goal": inferred_delivery_goal or str(content_dict.get("goal") or "").strip() or "final deliverable",
            "inferred": True,
        }

    def _infer_intent_decomposition(content_dict: dict[str, Any], delivery_contract: dict[str, Any]) -> dict[str, Any]:
        explicit = content_dict.get("intent_decomposition")
        if isinstance(explicit, dict):
            return explicit
        requested_operation = str(
            content_dict.get("round_goal") or content_dict.get("goal") or ""
        ).strip()
        delivery_goal = str(delivery_contract.get("delivery_goal") or "").strip() or requested_operation
        preferred_tools: list[str] = []
        haystack = f"{requested_operation} {delivery_goal}".lower()
        if any(token in haystack for token in ("browser", "浏览器", "网页", "open page")):
            preferred_tools.append("browser")
        if any(token in haystack for token in ("search", "搜索", "检索", "news", "新闻")):
            preferred_tools.append("search")
        if any(token in haystack for token in ("report", "报告", "research", "研究")):
            preferred_tools.append("report_writer")
        return {
            "requested_operation": requested_operation,
            "delivery_goal": delivery_goal,
            "execution_preference": {
                "preferred_tools": preferred_tools,
                "must_use_tools": False,
            },
            "inferred": True,
        }

    steps = [
        PlanStep(
            id=step.get("id", f"step_{i}"),
            title=step.get("title", ""),
            phase=str(step.get("phase") or "").strip() or None,
            intent=str(step.get("intent") or "").strip() or None,
            inputs_required=_list_of_strings(step.get("inputs_required")),
            expected_outputs=_list_of_strings(step.get("expected_outputs")),
            execution_constraints=_list_of_strings(step.get("execution_constraints")),
            completion_criteria=_list_of_strings(step.get("completion_criteria")),
            input_refs=_parse_input_refs(step),
            output_contract=_parse_output_contract(step) or _infer_output_contract(step),
            skill_source=step.get("skill_source"),
            parallel=step.get("parallel", False),
        )
        for i, step in enumerate(raw_steps)
    ]

    for index, step in enumerate(steps):
        if step.input_refs:
            continue
        if index == 0:
            continue
        previous = steps[index - 1]
        step.input_refs = [
            StepInputRef(
                name=f"prior_output_{previous.id}",
                required=True,
                source_step_id=previous.id,
                preferred_medium="artifact_result_text",
                fallback_medium="artifact_result_path",
                notes="default contract inferred from prior step output",
            )
        ]

    plan_type = str(content.get("type") or "plan").strip().lower() or "plan"
    if plan_type not in {"plan", "delegate", "terminate"}:
        plan_type = "plan"

    final_delivery_contract = _infer_final_delivery_contract(content, steps)
    return ExecutionPlan(
        plan_type=plan_type,  # type: ignore[arg-type]
        goal=content.get("goal", ""),
        plan_version=max(int(content.get("plan_version") or 1), 1),
        selected_skill=str(content.get("selected_skill") or "").strip() or None,
        round_goal=str(content.get("round_goal") or "").strip() or None,
        plan_mode=str(content.get("plan_mode") or "initial").strip() or "initial",
        planning_rationale=(
            content.get("planning_rationale")
            if isinstance(content.get("planning_rationale"), dict)
            else {}
        ),
        intent_decomposition=_infer_intent_decomposition(content, final_delivery_contract),
        final_delivery_contract=final_delivery_contract,
        current_date=str(content.get("current_date") or "").strip() or None,
        current_weekday=str(content.get("current_weekday") or "").strip() or None,
        current_timezone=str(content.get("current_timezone") or "").strip() or None,
        skill_context_for_act=(
            content.get("skill_context_for_act")
            if isinstance(content.get("skill_context_for_act"), dict)
            else None
        ),
        stop_or_replan_conditions=_list_of_strings(content.get("stop_or_replan_conditions")),
        steps=steps,
        terminate_reason=str(content.get("reason") or "").strip() or None,
        terminate_status=(
            str(content.get("status") or "").strip() or None
        ),  # type: ignore[arg-type]
        summary_for_act=str(
            content.get("summary_for_act") or content.get("content") or ""
        ).strip()
        or None,
        user_reply=str(content.get("user_reply") or "").strip() or None,
        sub_agent_id=str(content.get("sub_agent_id") or "").strip() or None,
        delegate_context=(
            str(content.get("context_for_delegate") or content.get("context") or "").strip() or None
        ),
        delegate_reason=str(content.get("why_delegate") or "").strip() or None,
        delegate_expected_outputs=_list_of_strings(content.get("expected_outputs")),
        delegate_return_conditions=_list_of_strings(content.get("return_conditions")),
    )


def parse_reflection_response(response: dict[str, Any]) -> ReflectionResult:
    """
    Parse an LLM reflection response.

    Args:
        response: The LLM response dict containing summary, lessons, etc.

    Returns:
        Parsed ReflectionResult object
    """
    return ReflectionResult(
        summary=response.get("summary", "Task completed."),
        lessons_learned=response.get("lessons_learned", []),
        worth_remembering=response.get("worth_remembering", False),
        importance=response.get("importance", 0.5),
    )


def is_critical_failure(result: ToolCallResult) -> bool:
    """
    Determine if a failure is critical and should stop execution.

    Critical failures include:
    - Authentication errors
    - Rate limiting
    - Service unavailable

    Args:
        result: The failed tool call result

    Returns:
        True if this is a critical failure
    """
    if not result.error:
        return False

    critical_patterns = [
        "authentication",
        "unauthorized",
        "rate limit",
        "quota exceeded",
        "service unavailable",
    ]

    error_lower = result.error.lower()
    return any(pattern in error_lower for pattern in critical_patterns)
