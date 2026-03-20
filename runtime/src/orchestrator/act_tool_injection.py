"""ACT tool-call injection helpers: context data, file-IO artifact binding."""

import json
import os
import re as _re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from src.orchestrator.act_context import (
    _match_generated_artifact_reference,
)
from src.orchestrator.nodes_stateflow import (
    _build_act_artifact_context,
)
from src.orchestrator.state import Artifact, PlanStep, ToolCallResult
from src.utils.logging import get_logger

logger = get_logger(__name__)

# File-write markers used to detect real artifact generation in code_executor output.
_REAL_ARTIFACT_MARKERS = (
    "open(",
    ".write(",
    "write_text(",
    "write_bytes(",
    "to_csv(",
    "to_excel(",
    "to_json(",
    "savefig(",
    "workbook.save(",
    "pdf.save(",
)

# --- Disabled: finance research filtering (non-generic) ---
_FINANCE_RESEARCH_PATTERNS: tuple[str, ...] = ()
_FINANCE_NOISE_DOMAIN_PATTERNS: tuple[str, ...] = ()


def _is_finance_research_intent(text: str) -> bool:  # noqa: ARG001
    return False


# --- Disabled: summary intent detection for code_executor (non-generic) ---
def _code_executor_embeds_bound_text_for_summary_only(
    *,
    code: str,  # noqa: ARG001
    action: PlanStep,  # noqa: ARG001
    artifacts: list[dict[str, Any]],  # noqa: ARG001
) -> bool:
    return False


def _extract_finance_focus_tokens(user_text: str) -> list[str]:  # noqa: ARG001
    return []


def _filter_finance_search_results(
    results: list[dict[str, Any]],
    user_text: str,  # noqa: ARG001
) -> list[dict[str, Any]]:
    return results


def _inject_context_data(
    action: PlanStep,
    search_results: list[dict[str, Any]],
    session_id: str,
    user_request: str | None = None,
) -> None:
    """Inject search results as context_data into file-generation actions."""
    if action.tool not in {"xlsx", "pdf"} or not search_results:
        return
    # Pass through all results without domain-specific filtering.
    payload = {
        "results": search_results,
        "user_request": user_request or "",
        "generated_at": datetime.now(timezone.utc).isoformat(),
    }
    context_json = json.dumps(payload, ensure_ascii=False)
    existing = action.params.get("context_data", "")
    action.params["context_data"] = context_json
    logger.info(
        "Auto-injected context_data into file-generation step",
        extra={
            "session_id": session_id,
            "step_id": action.id,
            "context_data_len": len(context_json),
            "search_results_count": len(search_results),
            "had_existing": bool(existing),
        },
    )


def _inject_file_io_session_artifacts(
    action: PlanStep,
    prior_results: list[ToolCallResult],
    runtime_context: Any | None,
    session_id: str,
) -> None:
    if (action.tool or "").strip() != "file_io":
        return
    params = action.params if isinstance(action.params, dict) else {}
    action_name = str(params.get("action") or params.get("operation") or "").strip().lower()
    raw_path = str(params.get("path") or "").strip()
    if action_name not in {"read", "list"} or not raw_path:
        return
    if raw_path.startswith("/"):
        return

    generated = [
        str(item.get("artifact_result_path") or "").strip()
        for item in _build_act_artifact_context(prior_results, runtime_context)
        if str(item.get("artifact_result_path") or "").strip()
    ]
    metadata = getattr(runtime_context, "metadata", None)
    if not isinstance(metadata, dict):
        return
    session_root_raw = metadata.get("session_working_dir")
    if not isinstance(session_root_raw, str) or not session_root_raw.strip():
        return
    try:
        session_root = Path(session_root_raw).expanduser().resolve()
    except Exception:
        return

    requested = raw_path.replace("\\", "/").lstrip("./")
    matched_generated = _match_generated_artifact_reference(generated, requested)
    if matched_generated:
        try:
            relative = Path(matched_generated).resolve().relative_to(session_root)
        except Exception:
            relative = None
        if relative is not None:
            replacement = str(relative).replace("\\", "/")
            if replacement != raw_path:
                params["path"] = replacement
                action.params = params
                logger.info(
                    "file_io_session_artifact_injected",
                    extra={
                        "session_id": session_id,
                        "step_id": action.id,
                        "path": replacement,
                    },
                )
                return

    replacement: str | None = None
    for candidate in reversed(generated):
        try:
            candidate_path = Path(str(candidate)).expanduser().resolve()
        except Exception:
            continue
        if not candidate_path.exists():
            continue
        if candidate_path.name != Path(requested).name and not str(candidate_path).replace("\\", "/").endswith(requested):
            continue
        try:
            relative = candidate_path.relative_to(session_root)
        except Exception:
            continue
        replacement = str(relative).replace("\\", "/")
        break

    if replacement and replacement != raw_path:
        params["path"] = replacement
        action.params = params
        logger.info(
            "file_io_session_artifact_injected",
            extra={
                "session_id": session_id,
                "step_id": action.id,
                "path": replacement,
            },
        )
        return

    # Fallback: if prior results did not surface generated_files metadata,
    # search the session workspace for a basename match under tool_runs.
    requested_name = Path(requested).name
    if not requested_name:
        return
    try:
        tool_runs_root = session_root / "tool_runs"
        if not tool_runs_root.exists() or not tool_runs_root.is_dir():
            return
        matches = sorted(
            [
                p for p in tool_runs_root.rglob(requested_name)
                if p.is_file()
            ],
            key=lambda p: p.stat().st_mtime,
        )
    except Exception:
        return
    if not matches:
        return
    try:
        relative = matches[-1].resolve().relative_to(session_root)
    except Exception:
        return
    fallback_replacement = str(relative).replace("\\", "/")
    if fallback_replacement != raw_path:
        params["path"] = fallback_replacement
        action.params = params
        logger.info(
            "file_io_session_artifact_injected_from_workspace_scan",
            extra={
                "session_id": session_id,
                "step_id": action.id,
                "path": fallback_replacement,
            },
        )


def _prepare_artifact_aware_action(
    action: PlanStep,
    *,
    prior_results: list[ToolCallResult | dict[str, Any]],
    runtime_context: Any | None,
    session_id: str,
    selected_skill_name: str = "",
) -> None:
    from src.orchestrator.act_tool_executor import _bind_file_io_skill_scope, _inject_skill_script_artifacts

    tool_name = str(action.tool or "").strip()
    if tool_name == "file_io":
        _bind_file_io_skill_scope(action, selected_skill_name)
        _inject_file_io_session_artifacts(action, prior_results, runtime_context, session_id)
        return
    if tool_name == "skill_script_runner":
        _inject_skill_script_artifacts(action, prior_results, session_id)


_ENABLE_FRESHNESS_VALIDATION = str(os.getenv("SEMIBOT_ENABLE_FRESHNESS_VALIDATION", "false")).strip().lower() in {
    "1",
    "true",
    "yes",
    "on",
}


def _get_freshness_validation_flag() -> bool:
    """Read _ENABLE_FRESHNESS_VALIDATION from nodes_act module to respect monkeypatch."""
    import src.orchestrator.nodes_act as _nodes_act_mod
    return bool(getattr(_nodes_act_mod, "_ENABLE_FRESHNESS_VALIDATION", _ENABLE_FRESHNESS_VALIDATION))


# --- Disabled: latest intent detection (non-generic) ---
_LATEST_INTENT_TOKENS: tuple[str, ...] = ()


def _is_latest_research_intent(text: str) -> bool:  # noqa: ARG001
    return False


def _search_query_contains_stale_year(query: str, *, today: datetime) -> bool:  # noqa: ARG001
    return False


def _has_same_step_search_provider_failures(
    current_step_results: list[ToolCallResult] | None,  # noqa: ARG001
    *,
    min_failures: int = 2,  # noqa: ARG001
) -> bool:
    """Disabled: search provider failure detection (non-generic)."""
    return False


def _synthesize_artifacts_from_legacy(metadata: dict[str, Any], step_id: str) -> list[Artifact]:
    """Build unified Artifact objects from legacy metadata fields.

    Called at the end of _ensure_step_result_handoff_contract so that every
    ToolCallResult leaving the ACT pipeline has its ``artifacts`` list populated,
    regardless of whether the original producer used the unified protocol.
    """
    artifacts: list[Artifact] = []
    seen_paths: set[str] = set()

    # 1. File artifacts from generated_files
    generated_files = metadata.get("generated_files")
    if isinstance(generated_files, list):
        for item in generated_files:
            if not isinstance(item, dict):
                continue
            path_val = str(item.get("path") or item.get("artifact_result_path") or "").strip()
            if not path_val or path_val in seen_paths:
                continue
            seen_paths.add(path_val)
            artifacts.append(Artifact(
                medium="file",
                file_path=path_val,
                artifact_name=str(item.get("filename") or item.get("artifact_name") or "").strip(),
                artifact_role=str(item.get("artifact_role") or "").strip(),
                source_step_id=step_id or None,
            ))

    # 2. Single file artifact from artifact_result_path
    single_path = str(metadata.get("artifact_result_path") or "").strip()
    if single_path and single_path not in seen_paths:
        seen_paths.add(single_path)
        artifacts.append(Artifact(
            medium="file",
            file_path=single_path,
            artifact_name=str(metadata.get("artifact_name") or "").strip(),
            artifact_role=str(metadata.get("artifact_role") or "").strip(),
            artifact_type=str(metadata.get("artifact_type") or "").strip(),
            source_step_id=step_id or None,
        ))

    # 3. Text artifact from text_artifact dict or artifact_result_text
    text_artifact = metadata.get("text_artifact")
    text_content = ""
    if isinstance(text_artifact, dict):
        text_content = str(text_artifact.get("artifact_result_text") or "").strip()
    if not text_content:
        text_content = str(metadata.get("artifact_result_text") or "").strip()
    if text_content:
        artifacts.append(Artifact(
            medium="text",
            text_content=text_content,
            artifact_name=str(metadata.get("artifact_name") or "text output").strip(),
            artifact_role=str(metadata.get("artifact_role") or "text").strip(),
            artifact_type=str(metadata.get("artifact_type") or "text_output").strip(),
            source_step_id=step_id or None,
            is_likely_final=bool(
                (isinstance(text_artifact, dict) and text_artifact.get("is_likely_final"))
                or metadata.get("is_likely_final")
            ),
        ))

    return artifacts
