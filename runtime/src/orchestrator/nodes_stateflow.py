"""Stateflow and handoff helper functions for orchestrator nodes."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from src.utils.logging import get_logger

from src.orchestrator.nodes_shared import _infer_artifact_semantics
from src.orchestrator.state import AgentState, ExecutionPlan, ToolCallResult

logger = get_logger(__name__)

_STATEFLOW_BINDING_TEXT_MAX_CHARS = 400


def _resolve_file_candidate(path_value: str, extra: dict[str, Any] | None = None) -> dict[str, Any] | None:
    """Resolve a file path to a normalized artifact entry, or None if invalid."""
    try:
        candidate_path = Path(path_value).expanduser()
        if not candidate_path.exists() or not candidate_path.is_file():
            return None
    except Exception as exc:
        logger.debug("_resolve_file_candidate: path resolution failed", extra={"path": path_value, "error": str(exc)})
        return None
    normalized = str(candidate_path.resolve())
    meta: dict[str, Any] = {"artifact_result_path": normalized}
    if isinstance(extra, dict):
        for key in ("filename", "path", "source_path", "artifact_role", "user_visible"):
            value = extra.get(key)
            if value not in (None, ""):
                meta[key] = value
    meta.update(_infer_artifact_semantics(candidate_path, str(meta.get("artifact_role") or "")))
    return meta


def _extract_generated_file_context_entries(results: list[ToolCallResult]) -> list[dict[str, Any]]:
    """Extract artifact context entries from tool results.

    Primary path: reads the unified ``artifacts`` list on each result.
    Legacy fallback: for results without unified artifacts (e.g. error results
    that bypass the handoff contract), falls back to metadata/payload fields.
    """
    candidates: list[dict[str, Any]] = []

    for result in results:
        if not getattr(result, "success", False):
            continue

        # --- Unified artifacts protocol (primary) ---
        unified_artifacts = getattr(result, "artifacts", None)
        if isinstance(unified_artifacts, list) and unified_artifacts:
            for artifact in unified_artifacts:
                if not hasattr(artifact, "medium"):
                    continue
                if artifact.medium == "file" and artifact.file_path:
                    entry = _resolve_file_candidate(
                        str(artifact.file_path),
                        {"artifact_role": artifact.artifact_role or None, "filename": artifact.artifact_name or None},
                    )
                    if entry is not None:
                        candidates.append(entry)
                elif artifact.medium == "text" and artifact.text_content:
                    candidates.append({
                        "artifact_medium": "text",
                        "artifact_format": "plain_text",
                        "artifact_type": artifact.artifact_type or "text_output",
                        "artifact_name": artifact.artifact_name or "text output",
                        "artifact_purpose": "text output artifact",
                        "artifact_result_text": str(artifact.text_content),
                        "is_likely_final": bool(artifact.is_likely_final),
                        "artifact_role": artifact.artifact_role or "text",
                    })
            continue  # Skip legacy paths when unified artifacts are present

        # --- Legacy fallback (results that bypassed handoff contract) ---
        _extract_legacy_artifacts(result, candidates)

    return candidates


def _extract_legacy_artifacts(result: ToolCallResult, candidates: list[dict[str, Any]]) -> None:
    """Compact legacy artifact extraction for results without unified artifacts."""
    metadata = getattr(result, "metadata", None) or {}
    if not isinstance(metadata, dict):
        metadata = {}
    payload = getattr(result, "result", None)
    if not isinstance(payload, dict):
        payload = {}

    # File artifacts from generated_files lists
    for source in (metadata, payload):
        generated_files = source.get("generated_files")
        if isinstance(generated_files, list):
            for item in generated_files:
                if isinstance(item, dict) and str(item.get("path") or "").strip():
                    entry = _resolve_file_candidate(str(item["path"]).strip(), item)
                    if entry is not None:
                        candidates.append(entry)

    # Direct file path from metadata or payload
    for source in (metadata, payload):
        direct_path = str(source.get("artifact_result_path") or "").strip()
        if direct_path:
            entry = _resolve_file_candidate(direct_path, {
                "artifact_role": source.get("artifact_role"),
                "filename": source.get("artifact_name") or source.get("filename"),
            })
            if entry is not None:
                candidates.append(entry)

    # Text artifact from metadata
    text_artifact = metadata.get("text_artifact")
    if isinstance(text_artifact, dict):
        candidates.append(dict(text_artifact))
        return  # text_artifact is authoritative; skip payload text

    # Text from payload
    text_result = payload.get("artifact_result_text")
    if text_result:
        candidates.append({
            "artifact_medium": "text",
            "artifact_format": "plain_text",
            "artifact_type": str(payload.get("artifact_type") or "text_output").strip() or "text_output",
            "artifact_name": str(payload.get("artifact_name") or "text output").strip() or "text output",
            "artifact_purpose": str(payload.get("artifact_purpose") or "text output artifact").strip() or "text output artifact",
            "artifact_result_text": str(text_result),
            "is_likely_final": bool(payload.get("is_likely_final", False)),
            "artifact_role": str(payload.get("artifact_role") or "text").strip() or "text",
        })


def _build_act_artifact_context(
    results: list[ToolCallResult],
    runtime_context: Any | None,
) -> list[dict[str, Any]]:
    artifacts: list[dict[str, Any]] = []
    session_root: Path | None = None
    metadata = getattr(runtime_context, "metadata", None)
    if isinstance(metadata, dict):
        raw = str(metadata.get("session_working_dir") or "").strip()
        if raw:
            try:
                session_root = Path(raw).expanduser().resolve()
            except Exception:
                session_root = None

    seen: set[str] = set()
    for entry in _extract_generated_file_context_entries(results):
        path_str = str(entry.get("artifact_result_path") or "").strip()
        if path_str:
            try:
                path_obj = Path(path_str).expanduser().resolve()
            except Exception:
                continue
            normalized = str(path_obj)
            if normalized in seen:
                continue
            seen.add(normalized)
            item: dict[str, Any] = dict(entry)
            item["artifact_result_path"] = normalized
            if session_root is not None:
                try:
                    item["workspace_relative_path"] = str(path_obj.relative_to(session_root)).replace("\\", "/")
                except Exception:
                    pass
            artifacts.append(item)
            continue
        text_value = str(entry.get("artifact_result_text") or "").strip()
        if text_value:
            text_key = f"text::{hash(text_value)}::{entry.get('artifact_type')}"
            if text_key in seen:
                continue
            seen.add(text_key)
            artifacts.append(dict(entry))
    return artifacts


def _artifact_matches_input_ref(
    artifact: dict[str, Any],
    input_ref: Any,
    expected_artifact_role: str | None = None,
) -> bool:
    expected_role = str(expected_artifact_role or "").strip().lower()
    actual_role = str(artifact.get("artifact_role") or "").strip().lower()
    if expected_role and actual_role and expected_role != actual_role:
        return False
    source_step_id = str(getattr(input_ref, "source_step_id", "") or "").strip()
    if source_step_id:
        actual_step_id = str(artifact.get("source_step_id") or "").strip()
        if actual_step_id and actual_step_id != source_step_id:
            return False
    return True


def _resolve_input_binding_from_artifact(
    artifact: dict[str, Any],
    input_ref: Any,
    expected_artifact_role: str | None = None,
) -> dict[str, Any] | None:
    preferred_medium = str(getattr(input_ref, "preferred_medium", "") or "").strip() or "artifact_result_text"
    fallback_medium = str(getattr(input_ref, "fallback_medium", "") or "").strip() or None
    artifact_text = str(artifact.get("artifact_result_text") or "").strip()
    artifact_path = str(artifact.get("artifact_result_path") or "").strip()

    resolved_medium = None
    resolved_value = None
    if preferred_medium == "artifact_result_text" and artifact_text:
        resolved_medium = "artifact_result_text"
        resolved_value = artifact_text
    elif preferred_medium == "artifact_result_path" and artifact_path:
        resolved_medium = "artifact_result_path"
        resolved_value = artifact_path
    elif fallback_medium == "artifact_result_text" and artifact_text:
        resolved_medium = "artifact_result_text"
        resolved_value = artifact_text
    elif fallback_medium == "artifact_result_path" and artifact_path:
        resolved_medium = "artifact_result_path"
        resolved_value = artifact_path

    if resolved_medium is None:
        return None

    truncated_resolved_value = resolved_value
    if isinstance(truncated_resolved_value, str) and len(truncated_resolved_value) > _STATEFLOW_BINDING_TEXT_MAX_CHARS:
        truncated_resolved_value = truncated_resolved_value[:_STATEFLOW_BINDING_TEXT_MAX_CHARS] + "...[truncated]"
    truncated_artifact_text = artifact_text or None
    if isinstance(truncated_artifact_text, str) and len(truncated_artifact_text) > _STATEFLOW_BINDING_TEXT_MAX_CHARS:
        truncated_artifact_text = truncated_artifact_text[:_STATEFLOW_BINDING_TEXT_MAX_CHARS] + "...[truncated]"

    return {
        "input_name": str(getattr(input_ref, "name", "") or "").strip(),
        "required": bool(getattr(input_ref, "required", True)),
        "source_step_id": str(artifact.get("source_step_id") or getattr(input_ref, "source_step_id", "") or "").strip() or None,
        "artifact_role": str(artifact.get("artifact_role") or expected_artifact_role or "").strip() or None,
        "preferred_medium": preferred_medium,
        "resolved_medium": resolved_medium,
        "resolved_value": truncated_resolved_value,
        "artifact_result_text": truncated_artifact_text,
        "artifact_result_path": artifact_path or None,
        "artifact_name": str(artifact.get("artifact_name") or "").strip() or None,
    }


def _build_step_input_bindings(
    plan: ExecutionPlan | None,
    artifacts: list[dict[str, Any]],
) -> dict[str, list[dict[str, Any]]]:
    if not isinstance(plan, ExecutionPlan):
        return {}
    steps_by_id = {
        str(step.id or "").strip(): step
        for step in plan.steps
        if str(step.id or "").strip()
    }
    bindings: dict[str, list[dict[str, Any]]] = {}
    for step in plan.steps:
        if not step.input_refs:
            continue
        step_bindings: list[dict[str, Any]] = []
        for input_ref in step.input_refs:
            source_step_id = str(getattr(input_ref, "source_step_id", "") or "").strip()
            source_step = steps_by_id.get(source_step_id) if source_step_id else None
            source_output_contract = getattr(source_step, "output_contract", None)
            expected_artifact_role = (
                str(getattr(source_output_contract, "artifact_role", "") or "").strip() or None
            )
            matched_binding = None
            for artifact in reversed(artifacts):
                if not _artifact_matches_input_ref(artifact, input_ref, expected_artifact_role):
                    continue
                matched_binding = _resolve_input_binding_from_artifact(
                    artifact,
                    input_ref,
                    expected_artifact_role,
                )
                if matched_binding is not None:
                    step_bindings.append(matched_binding)
                    break
            if matched_binding is None and bool(getattr(input_ref, "required", True)):
                step_bindings.append(
                    {
                        "input_name": str(getattr(input_ref, "name", "") or "").strip(),
                        "required": True,
                        "source_step_id": source_step_id or None,
                        "artifact_role": expected_artifact_role,
                        "preferred_medium": str(getattr(input_ref, "preferred_medium", "") or "").strip() or "artifact_result_text",
                        "resolved_medium": None,
                        "resolved_value": None,
                        "binding_missing": True,
                    }
                )
        if step_bindings:
            bindings[str(step.id or "").strip() or f"__synthetic_{len(bindings) + 1}"] = step_bindings
    return bindings


def _build_execution_state_for_planner(
    state: AgentState,
    *,
    prefer_existing: bool = True,
) -> dict[str, Any]:
    existing_execution_state = state.get("execution_state")
    if prefer_existing and isinstance(existing_execution_state, dict) and existing_execution_state:
        return {
            "completed_steps": list(existing_execution_state.get("completed_steps") or []),
            "in_progress_steps": list(existing_execution_state.get("in_progress_steps") or []),
            "failed_steps": list(existing_execution_state.get("failed_steps") or []),
            "observations": list(existing_execution_state.get("observations") or []),
            "artifacts_produced": list(existing_execution_state.get("artifacts_produced") or []),
            "unresolved_questions": list(existing_execution_state.get("unresolved_questions") or []),
            "known_constraints": list(existing_execution_state.get("known_constraints") or []),
            "remaining_budget_or_limits": list(
                existing_execution_state.get("remaining_budget_or_limits") or []
            ),
            "step_input_bindings": dict(existing_execution_state.get("step_input_bindings") or {}),
        }

    plan = state.get("plan")
    tool_results = [
        result
        for result in list(state.get("tool_results") or [])
        if not (
            isinstance(getattr(result, "metadata", None), dict)
            and getattr(result, "metadata", {}).get("dr_mode") is True
        )
    ]
    completed_steps: list[str] = []
    in_progress_steps: list[str] = []
    failed_steps: list[str] = []
    observations: list[str] = []
    artifacts_produced: list[str] = []
    unresolved_questions: list[str] = []
    known_constraints: list[str] = []

    # Companion sets for O(1) dedup lookups (lists preserve insertion order)
    _seen_completed: set[str] = set()
    _seen_in_progress: set[str] = set()
    _seen_failed: set[str] = set()
    _seen_observations: set[str] = set()
    _seen_artifacts: set[str] = set()
    _seen_questions: set[str] = set()
    _seen_constraints: set[str] = set()

    _seen_map: dict[int, set[str]] = {
        id(completed_steps): _seen_completed,
        id(in_progress_steps): _seen_in_progress,
        id(failed_steps): _seen_failed,
        id(observations): _seen_observations,
        id(artifacts_produced): _seen_artifacts,
        id(unresolved_questions): _seen_questions,
        id(known_constraints): _seen_constraints,
    }

    def _append_unique(target: list[str], value: str) -> None:
        item = str(value or "").strip()
        if not item:
            return
        seen = _seen_map[id(target)]
        if item not in seen:
            seen.add(item)
            target.append(item)

    if isinstance(plan, ExecutionPlan):
        # First pass: collect actual statuses from all steps
        for idx, step in enumerate(plan.steps):
            step_id = str(step.id or f"step-{idx + 1}")
            status = str(getattr(step, "status", "") or "").strip().lower()
            if status == "running" and step_id not in _seen_in_progress:
                _seen_in_progress.add(step_id)
                in_progress_steps.append(step_id)
            elif status == "failed" and step_id not in _seen_failed:
                _seen_failed.add(step_id)
                failed_steps.append(step_id)
            elif status == "completed" and step_id not in _seen_completed:
                _seen_completed.add(step_id)
                completed_steps.append(step_id)

    for result in tool_results:
        tool_name = str(getattr(result, "tool_name", "") or "").strip()
        metadata = getattr(result, "metadata", {}) or {}
        if isinstance(metadata, dict):
            act_decision = str(metadata.get("act_decision") or "").strip().lower()
            step_id = str(metadata.get("act_step_id") or "").strip()
            if act_decision in {"advance_step", "complete_task"} and step_id:
                _append_unique(completed_steps, step_id)
            elif act_decision == "continue_current_step" and step_id:
                _append_unique(in_progress_steps, step_id)
            for item in metadata.get("act_artifacts_produced") or []:
                _append_unique(artifacts_produced, str(item))
            raw_observations = metadata.get("act_observations")
            if isinstance(raw_observations, list):
                for item in raw_observations:
                    if not isinstance(item, dict):
                        continue
                    summary = str(item.get("summary") or "").strip()
                    if summary:
                        _append_unique(observations, summary)
                    for constraint in item.get("constraints_encountered") or []:
                        _append_unique(known_constraints, str(constraint))
        if not tool_name:
            continue
        if getattr(result, "success", False):
            _append_unique(observations, f"{tool_name}: success")
        else:
            error_text = str(getattr(result, "error", "") or "").strip()
            _append_unique(observations, f"{tool_name}: failed - {error_text[:200]}")
            if error_text:
                _append_unique(known_constraints, error_text[:200])
        generated_files = metadata.get("generated_files", []) if isinstance(metadata, dict) else []
        if isinstance(generated_files, list):
            for item in generated_files:
                if not isinstance(item, dict):
                    continue
                filename = str(item.get("filename") or item.get("path") or "").strip()
                if filename:
                    _append_unique(artifacts_produced, filename)

    artifact_context = _build_act_artifact_context(
        tool_results,
        state.get("context"),
    )
    step_input_bindings = _build_step_input_bindings(plan, artifact_context)

    return {
        "completed_steps": completed_steps,
        "in_progress_steps": in_progress_steps,
        "failed_steps": failed_steps,
        "observations": observations,
        "artifacts_produced": artifacts_produced,
        "unresolved_questions": unresolved_questions,
        "known_constraints": known_constraints,
        "remaining_budget_or_limits": [],
        "step_input_bindings": step_input_bindings,
    }
