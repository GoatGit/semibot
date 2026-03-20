"""Plan validation: contract checks, skill wrapper detection, freshness validation."""

import re as _re
from contextlib import suppress
from typing import Any

from src.orchestrator.state import ExecutionPlan, PlanStep
from src.utils.logging import get_logger

logger = get_logger(__name__)

# --- Disabled: latest intent patterns (non-generic) ---
_LATEST_INTENT_PATTERNS: tuple[str, ...] = ()


def _candidate_plan_skill_context_skill_id(plan: ExecutionPlan | None) -> str:
    if not isinstance(plan, ExecutionPlan):
        return ""
    skill_context = plan.skill_context_for_act
    if isinstance(skill_context, dict):
        skill_id = str(skill_context.get("skill_id") or "").strip()
        if skill_id:
            return skill_id
    return str(plan.selected_skill or "").strip()


def _is_latest_intent(text: str) -> bool:  # noqa: ARG001
    return False


def _plan_contains_stale_year_for_latest_request(
    plan: ExecutionPlan,  # noqa: ARG001
    *,
    current_date: str,  # noqa: ARG001
) -> str | None:
    """Disabled: stale year detection (non-generic)."""
    return None


def _lookup_enabled_skill_item(runtime_context: Any | None, skill_id: str) -> dict[str, Any] | None:
    if runtime_context is None or not skill_id:
        return None
    metadata = getattr(runtime_context, "metadata", None)
    raw = metadata.get("skill_index") if isinstance(metadata, dict) else None
    if not isinstance(raw, list):
        return None
    normalized = str(skill_id).strip().lower()
    for item in raw:
        if not isinstance(item, dict):
            continue
        candidate = str(item.get("skill_id") or item.get("id") or item.get("name") or "").strip().lower()
        if candidate == normalized and item.get("enabled", True) is not False:
            return item
    return None


def _extract_loaded_skill_phase_outline(skill_md: str) -> list[str]:  # noqa: ARG001
    """Disabled: skill phase outline extraction (non-generic)."""
    return []


def _is_skill_wrapper_plan(candidate_plan: ExecutionPlan, selected_skill: str) -> bool:
    skill_id = str(selected_skill or "").strip().lower()
    if not skill_id or candidate_plan.plan_type != "plan" or not candidate_plan.steps:
        return False

    def _step_text(step: PlanStep) -> str:
        fields = [
            str(step.title or ""),
            str(step.phase or ""),
            str(step.intent or ""),
            " ".join(str(item or "") for item in (step.inputs_required or [])),
            " ".join(str(item or "") for item in (step.expected_outputs or [])),
            " ".join(str(item or "") for item in (step.execution_constraints or [])),
            " ".join(str(item or "") for item in (step.completion_criteria or [])),
        ]
        return " ".join(fields).strip().lower()

    def _looks_like_read_skill_step(text: str) -> bool:
        return bool(
            ("skill.md" in text)
            or ("技能文档" in text)
            or ("读取" in text and skill_id in text)
            or ("read" in text and ("skill" in text or skill_id in text))
        )

    def _looks_like_execute_skill_wrapper(text: str) -> bool:
        return bool(
            skill_id in text
            and any(token in text for token in ("执行", "运行", "调用", "use ", "using ", "execute ", "run "))
        )

    step_texts = [_step_text(step) for step in candidate_plan.steps]
    has_read_skill_step = any(_looks_like_read_skill_step(text) for text in step_texts)
    has_execute_skill_wrapper = any(_looks_like_execute_skill_wrapper(text) for text in step_texts)
    if has_read_skill_step:
        return True
    if len(step_texts) <= 2 and has_execute_skill_wrapper:
        return True
    return False


def _extract_raw_plan_steps_for_validation(parsed_response: dict[str, Any]) -> list[dict[str, Any]]:
    if not isinstance(parsed_response, dict):
        return []
    content = (
        parsed_response.get("content", parsed_response)
        if isinstance(parsed_response.get("content"), dict)
        else parsed_response
    )
    if not isinstance(content, dict):
        return []
    wrapped_plan = content.get("plan")
    if isinstance(wrapped_plan, dict):
        content = wrapped_plan
    raw_steps = content.get("steps")
    if isinstance(raw_steps, list):
        return [item for item in raw_steps if isinstance(item, dict)]
    raw_phases = content.get("phases")
    if isinstance(raw_phases, list):
        rows: list[dict[str, Any]] = []
        for phase in raw_phases:
            if not isinstance(phase, dict):
                continue
            phase_name = str(phase.get("name") or phase.get("phase") or "").strip()
            phase_steps = phase.get("steps")
            if not isinstance(phase_steps, list):
                continue
            for item in phase_steps:
                if not isinstance(item, dict):
                    continue
                normalized = dict(item)
                if phase_name and not str(normalized.get("phase") or "").strip():
                    normalized["phase"] = phase_name
                rows.append(normalized)
        return rows
    return []


def _planner_contract_validation_error(
    parsed_response: dict[str, Any],
    candidate_plan: ExecutionPlan,
    completed_step_ids: list[str] | None = None,
) -> str | None:
    if not isinstance(parsed_response, dict) or candidate_plan.plan_type != "plan" or not candidate_plan.steps:
        return None
    content = (
        parsed_response.get("content", parsed_response)
        if isinstance(parsed_response.get("content"), dict)
        else parsed_response
    )
    if isinstance(content, dict) and isinstance(content.get("plan"), dict):
        content = content.get("plan")
    if not isinstance(content, dict):
        return None
    explicit_intent = content.get("intent_decomposition")
    if explicit_intent is not None:
        if not isinstance(explicit_intent, dict):
            return "Invalid plan: intent_decomposition must be a JSON object."
        delivery_goal = str(explicit_intent.get("delivery_goal") or "").strip()
        requested_operation = str(explicit_intent.get("requested_operation") or "").strip()
        execution_preference = explicit_intent.get("execution_preference")
        if not delivery_goal or not requested_operation:
            return (
                "Invalid plan: intent_decomposition must include non-empty requested_operation "
                "and delivery_goal."
            )
        if execution_preference is not None and not isinstance(execution_preference, dict):
            return "Invalid plan: intent_decomposition.execution_preference must be an object when provided."

    explicit_delivery = content.get("final_delivery_contract")
    if explicit_delivery is not None:
        if not isinstance(explicit_delivery, dict):
            return "Invalid plan: final_delivery_contract must be a JSON object."
        delivery_goal = str(explicit_delivery.get("delivery_goal") or "").strip()
        if not delivery_goal:
            return "Invalid plan: final_delivery_contract.delivery_goal must be non-empty."

    raw_steps = _extract_raw_plan_steps_for_validation(parsed_response)
    raw_steps_by_id: dict[str, dict[str, Any]] = {}
    # Include completed step IDs from prior rounds so that replan input_refs
    # referencing them are not rejected as "unknown source_step_id".
    for cid in (completed_step_ids or []):
        cid = str(cid or "").strip()
        if cid:
            raw_steps_by_id[cid] = {"id": cid, "_completed_prior_round": True}
    for step in raw_steps:
        if not isinstance(step, dict):
            continue
        step_id = str(step.get("id") or "").strip()
        if step_id:
            raw_steps_by_id[step_id] = step

    for index, step in enumerate(raw_steps, start=1):
        if step.get("input_contract") is not None:
            return (
                f"Invalid plan: step {index} must not define input_contract. "
                "Planner may only declare input_refs; OBSERVE derives actual input bindings from prior step output_contract."
            )
        input_refs = step.get("input_refs")
        if input_refs is not None:
            if not isinstance(input_refs, list):
                return f"Invalid plan: step {index} input_refs must be an array when provided."
            if not input_refs:
                # Treat empty input_refs as omitted. The parser will infer the
                # default prior-step binding for non-initial steps.
                input_refs = []
            for item in input_refs:
                if not isinstance(item, dict):
                    return f"Invalid plan: step {index} input_refs entries must be objects."
                if not str(item.get("name") or "").strip():
                    return f"Invalid plan: step {index} input_refs entries must include name."
                if not str(item.get("preferred_medium") or "").strip():
                    return f"Invalid plan: step {index} input_refs entries must include preferred_medium."
                source_step_id = str(item.get("source_step_id") or "").strip()
                preferred_medium = str(item.get("preferred_medium") or "").strip()
                fallback_medium = str(item.get("fallback_medium") or "").strip()
                if source_step_id:
                    source_step = raw_steps_by_id.get(source_step_id)
                    if source_step is None:
                        return (
                            f"Invalid plan: step {index} input_refs references unknown source_step_id "
                            f"'{source_step_id}'."
                        )
                    # Completed steps from prior rounds are valid sources but don't
                    # carry output_contract in the current plan — skip contract checks.
                    if source_step.get("_completed_prior_round"):
                        continue
                    source_output_contract = (
                        source_step.get("output_contract")
                        if isinstance(source_step, dict)
                        else None
                    )
                    if not isinstance(source_output_contract, dict):
                        return (
                            f"Invalid plan: step {index} input_refs references {source_step_id}, "
                            "but that step does not define output_contract."
                        )
                    source_handoff_mode = str(source_output_contract.get("handoff_mode") or "").strip().lower()
                    source_must_text = source_output_contract.get("must_produce_text")
                    source_must_file = source_output_contract.get("must_materialize_file")
                    if preferred_medium == "artifact_result_text" and source_must_text is False and fallback_medium != "artifact_result_path":
                        return (
                            f"Invalid plan: step {index} input_refs expects artifact_result_text from {source_step_id}, "
                            "but that step does not require text output."
                        )
                    if preferred_medium == "artifact_result_path" and source_must_file is False and fallback_medium != "artifact_result_text":
                        return (
                            f"Invalid plan: step {index} input_refs expects artifact_result_path from {source_step_id}, "
                            "but that step does not materialize a file."
                        )
                    if source_handoff_mode == "file_only" and preferred_medium == "artifact_result_text" and fallback_medium != "artifact_result_path":
                        return (
                            f"Invalid plan: step {index} input_refs expects text from {source_step_id}, "
                            "but that step is file_only."
                        )
        output_contract = step.get("output_contract")
        if output_contract is not None:
            if not isinstance(output_contract, dict):
                return f"Invalid plan: step {index} output_contract must be an object when provided."
            primary_output_kind = str(output_contract.get("primary_output_kind") or "").strip()
            handoff_mode = str(output_contract.get("handoff_mode") or "").strip().lower()
            artifact_role = str(output_contract.get("artifact_role") or "").strip()
            handoff_purpose = str(output_contract.get("handoff_purpose") or "").strip()
            if not primary_output_kind or not artifact_role or not handoff_purpose:
                return (
                    f"Invalid plan: step {index} output_contract must include primary_output_kind, "
                    "artifact_role, and handoff_purpose."
                )
            if handoff_mode not in {"reasoning_text", "text_and_file", "file_only", "final_delivery"}:
                return (
                    f"Invalid plan: step {index} output_contract.handoff_mode must be one of "
                    "reasoning_text, text_and_file, file_only, final_delivery."
                )
            must_produce_text = output_contract.get("must_produce_text")
            must_materialize_file = output_contract.get("must_materialize_file")
            if not isinstance(must_produce_text, bool) or not isinstance(must_materialize_file, bool):
                return (
                    f"Invalid plan: step {index} output_contract must include boolean "
                    "must_produce_text and must_materialize_file."
                )
            if handoff_mode == "reasoning_text" and not must_produce_text:
                return (
                    f"Invalid plan: step {index} output_contract reasoning_text requires "
                    "must_produce_text=true."
                )
            if handoff_mode == "text_and_file" and (not must_produce_text or not must_materialize_file):
                return (
                    f"Invalid plan: step {index} output_contract text_and_file requires both "
                    "must_produce_text=true and must_materialize_file=true."
                )
            if handoff_mode == "file_only" and not must_materialize_file:
                return (
                    f"Invalid plan: step {index} output_contract file_only requires "
                    "must_materialize_file=true."
                )
    return None


def validate_plan_candidate(
    *,
    parsed_response: dict[str, Any],
    candidate_plan: ExecutionPlan,
    loaded_skill_id: str | None,
    loaded_skill_content: str,
    runtime_context: Any | None,
    completed_step_ids: list[str],
    prior_completed_step_refs: list[tuple[str, str]],
    requires_fresh_research: bool,
    session_current_date: str,
    enable_freshness_validation: bool,
) -> str | None:
    """Run all plan validation checks in order. Return rejection reason or None."""
    # 1. Hallucinated tool_calls
    if isinstance(parsed_response.get("tool_calls"), list):
        return (
            "Invalid planner output: your final JSON simulated tool_calls in content. "
            "If you need read_skill or inspect_sub_agent, use the actual runtime tool-calling interface. "
            "Otherwise, return exactly one final JSON object of type plan, delegate, or terminate, "
            "and never include a tool_calls field."
        )

    # 2. Contract validation
    contract_error = _planner_contract_validation_error(
        parsed_response, candidate_plan, completed_step_ids=completed_step_ids,
    )
    if contract_error:
        return contract_error + " Regenerate the plan with valid delivery and handoff contract fields."

    # 3. Selected skill without read_skill
    if isinstance(candidate_plan, ExecutionPlan):
        selected_skill = str(candidate_plan.selected_skill or "").strip()
        if (
            selected_skill
            and _lookup_enabled_skill_item(runtime_context, selected_skill)
            and str(loaded_skill_id or "").strip() != selected_skill
        ):
            return (
                f"Invalid plan: you selected skill '{selected_skill}' without first calling "
                f"read_skill('{selected_skill}'). If you select a skill from the skill index, "
                "you must load its SKILL.md first and then regenerate a semantic multi-step plan "
                "based on that SKILL.md. Do not return a wrapper plan like 'read skill' + 'execute skill'."
            )

    # 4. Missing skill_context_for_act
    if isinstance(candidate_plan, ExecutionPlan):
        selected_skill = str(candidate_plan.selected_skill or "").strip()
        if (
            selected_skill
            and _lookup_enabled_skill_item(runtime_context, selected_skill)
            and not (isinstance(candidate_plan.skill_context_for_act, dict) and candidate_plan.skill_context_for_act)
        ):
            return (
                f"Invalid plan: you selected skill '{selected_skill}' but did not provide "
                "skill_context_for_act. After reading the selected skill, extract the round-relevant "
                "execution rules, quality checks, artifact rules, replan triggers, and source sections "
                "into skill_context_for_act, then regenerate the semantic plan."
            )

    # 5. Invalid skill_context_for_act structure
    invalid_skill_context = _check_skill_context_structure(candidate_plan)
    if invalid_skill_context:
        return invalid_skill_context

    # 6. Empty/terminate after skill load
    # Allow terminate during replan if prior steps already completed meaningful work —
    # the LLM correctly recognizes the task is done and only the tail step failed.
    has_prior_completed_work = bool(completed_step_ids)
    if (
        str(loaded_skill_id or "").strip()
        and (
            str(candidate_plan.selected_skill or "").strip() == str(loaded_skill_id or "").strip()
            or not str(candidate_plan.selected_skill or "").strip()
        )
        and candidate_plan.plan_type in {"plan", "terminate"}
        and (candidate_plan.plan_type == "terminate" or not candidate_plan.steps)
        and not has_prior_completed_work
    ):
        loaded_phase_outline = _extract_loaded_skill_phase_outline(loaded_skill_content)
        phase_hint = ", ".join(loaded_phase_outline) if loaded_phase_outline else "skill-defined phases"
        return (
            f"Invalid plan: skill '{loaded_skill_id}' is already loaded for this planning session. "
            "Do not terminate or return an empty/generic plan after loading a skill. "
            "Regenerate a semantic, phase-aware plan that reflects the loaded methodology, "
            f"preserving the visible phase outline where relevant: {phase_hint}. "
            "Each returned step must correspond to actual skill-derived work, not a wrapper plan."
        )

    # 7. Wrapper plan
    if isinstance(candidate_plan, ExecutionPlan):
        selected_skill = str(candidate_plan.selected_skill or loaded_skill_id or "").strip()
        if (
            selected_skill
            and _lookup_enabled_skill_item(runtime_context, selected_skill)
            and _is_skill_wrapper_plan(candidate_plan, selected_skill)
        ):
            return (
                f"Invalid plan: skill '{selected_skill}' must be converted into actual task work, "
                "not wrapper steps like 'read skill document' or 'execute skill'. "
                "After loading the skill, regenerate a semantic plan whose steps correspond to "
                "actual phase work for the current task."
            )

    # 8. Plan without steps
    if (
        candidate_plan.plan_type == "plan"
        and not candidate_plan.steps
        and not requires_fresh_research
    ):
        return (
            "Invalid plan: type='plan' must include at least one semantic step. "
            "If no execution is needed, use terminate instead. "
            "Otherwise regenerate a plan with semantic steps."
        )

    # 9. Replan prefix validation
    replan_reason = _check_replan_prefix(
        candidate_plan, completed_step_ids, prior_completed_step_refs,
    )
    if replan_reason:
        return replan_reason

    # 10. Freshness validation
    if enable_freshness_validation and requires_fresh_research:
        stale_fragment = _plan_contains_stale_year_for_latest_request(
            candidate_plan, current_date=session_current_date,
        )
        if stale_fragment:
            return (
                "Invalid plan for a latest/current request: do not constrain the plan to older explicit years. "
                f"Today is {session_current_date}. Rewrite the plan to target the current timeframe instead. "
                f"Offending text: {stale_fragment[:200]}"
            )

    return None


def _check_skill_context_structure(candidate_plan: ExecutionPlan) -> str | None:
    """Validate skill_context_for_act structure if present."""
    if not isinstance(candidate_plan, ExecutionPlan):
        return None
    selected_skill = str(candidate_plan.selected_skill or "").strip()
    raw_skill_context = candidate_plan.skill_context_for_act
    if not selected_skill or not isinstance(raw_skill_context, dict):
        return None

    skill_id = str(raw_skill_context.get("skill_id") or "").strip()
    execution_rules = raw_skill_context.get("execution_rules")
    quality_checks = raw_skill_context.get("quality_checks")
    artifact_rules = raw_skill_context.get("artifact_rules")
    replan_triggers = raw_skill_context.get("replan_triggers")
    source_sections = raw_skill_context.get("source_sections")
    valid_rule_strengths = {"must", "should", "may"}

    def _valid_rule_list(value: Any) -> bool:
        if not isinstance(value, list) or not value:
            return False
        for item in value:
            if not isinstance(item, dict):
                return False
            instruction = str(item.get("instruction") or "").strip()
            strength = str(item.get("strength") or "").strip().lower()
            if not instruction or strength not in valid_rule_strengths:
                return False
        return True

    def _valid_trigger_list(value: Any) -> bool:
        if not isinstance(value, list) or not value:
            return False
        for item in value:
            if not isinstance(item, dict):
                return False
            if not str(item.get("instruction") or "").strip():
                return False
        return True

    if not (
        skill_id == selected_skill
        and _valid_rule_list(execution_rules)
        and _valid_rule_list(quality_checks)
        and _valid_rule_list(artifact_rules)
        and _valid_trigger_list(replan_triggers)
        and isinstance(source_sections, list)
        and any(str(section or "").strip() for section in source_sections)
    ):
        return (
            f"Invalid plan: skill_context_for_act for '{selected_skill}' must include skill_id, "
            "non-empty execution_rules/quality_checks/artifact_rules with instruction + strength(must|should|may), "
            "non-empty replan_triggers with instruction, and non-empty source_sections. Regenerate the plan."
        )
    return None


def _check_replan_prefix(
    candidate_plan: ExecutionPlan,
    completed_step_ids: list[str],
    prior_completed_step_refs: list[tuple[str, str]],
) -> str | None:
    """Validate replan completed-step prefix ordering."""
    if not (
        isinstance(candidate_plan, ExecutionPlan)
        and candidate_plan.plan_type == "plan"
        and completed_step_ids
        and candidate_plan.steps
    ):
        return None

    candidate_step_ids = [str(step.id or "").strip() for step in candidate_plan.steps]
    candidate_step_titles = [str(step.title or "").strip() for step in candidate_plan.steps]
    retained_completed_prefix_ids = [
        step_id for step_id in completed_step_ids if step_id in candidate_step_ids
    ]

    if retained_completed_prefix_ids:
        candidate_prefix_ids = candidate_step_ids[: len(retained_completed_prefix_ids)]
        if candidate_prefix_ids != retained_completed_prefix_ids:
            return (
                "Invalid replan: completed steps must not reappear as pending work. "
                "If you retain already completed steps in the new plan, keep them as the leading "
                "completed prefix with the same stable step IDs and continue from the next pending step."
            )
        # Mark retained completed prefix steps as completed
        for _prefix_step in candidate_plan.steps[: len(retained_completed_prefix_ids)]:
            _prefix_step.status = "completed"

    if prior_completed_step_refs:
        for idx, (_prior_id, prior_title) in enumerate(prior_completed_step_refs):
            if not prior_title or idx >= len(candidate_step_titles):
                continue
            if candidate_step_titles[idx] == prior_title and candidate_step_ids[idx] != _prior_id:
                return (
                    "Invalid replan: carried-forward completed steps must preserve stable step IDs. "
                    "Do not rename or renumber already completed steps when regenerating the plan."
                )

    return None
