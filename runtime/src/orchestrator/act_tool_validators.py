"""Declarative validation rules for ACT tool calls.

Each rule is a named function returning ``str | None`` (rejection reason or
``None`` = pass).  ``validate_act_tool_call`` iterates the rule list in
priority order and returns the first rejection as a ``ToolCallResult``.
"""

from __future__ import annotations

import re as _re
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Literal

from src.orchestrator.act_context import (
    _build_step_memory,
    _normalize_workspace_rel_path,
    _paths_look_semantically_equivalent,
)
from src.orchestrator.act_terminal import _step_requires_interactive_browser
from src.orchestrator.nodes_stateflow import (
    _artifact_matches_input_ref,
    _build_act_artifact_context,
    _resolve_input_binding_from_artifact,
)
from src.orchestrator.state import PlanStep, ToolCallResult
from src.utils.logging import get_logger

logger = get_logger(__name__)

# ---------------------------------------------------------------------------
# Shared context built once per validation call
# ---------------------------------------------------------------------------

@dataclass
class ToolValidationContext:
    """Pre-computed context shared across all rules for a single call."""

    action: PlanStep
    tool_name: str
    params: dict[str, Any]
    prior_results: list[ToolCallResult]
    current_step_results: list[ToolCallResult]
    runtime_context: Any | None
    latest_user_text: str
    today: datetime
    # Derived (lazily populated by _prepare_file_io_context)
    artifacts: list[dict[str, Any]] = field(default_factory=list)
    path: str = ""
    normalized_path: str = ""
    action_name: str = ""
    current_primary_path: str = ""
    contract_bindings: list[dict[str, Any]] = field(default_factory=list)
    missing_required_contracts: list[dict[str, Any]] = field(default_factory=list)
    # Preferred-text bindings (populated by _prepare_file_io_context)
    preferred_text_bindings: list[dict[str, Any]] = field(default_factory=list)
    path_bindings: list[dict[str, Any]] = field(default_factory=list)


def _prepare_file_io_context(ctx: ToolValidationContext) -> None:
    """Populate file_io-specific derived fields on *ctx* (mutates in place)."""
    params = ctx.params
    ctx.path = str(params.get("path") or "").strip()
    ctx.action_name = str(
        params.get("action") or params.get("operation") or ""
    ).strip().lower()
    ctx.normalized_path = _normalize_workspace_rel_path(ctx.path)
    ctx.artifacts = _build_act_artifact_context(ctx.prior_results, ctx.runtime_context)

    step_memory = _build_step_memory(ctx.current_step_results, ctx.runtime_context)
    current_primary_output = step_memory.get("current_primary_output") or {}
    ctx.current_primary_path = _normalize_workspace_rel_path(
        str(current_primary_output.get("artifact_result_path") or "")
    )

    # Resolve input-ref bindings
    ctx.contract_bindings = []
    ctx.missing_required_contracts = []
    if ctx.action.input_refs:
        for input_ref in ctx.action.input_refs:
            source_step_id = str(getattr(input_ref, "source_step_id", "") or "").strip()
            matched_binding = None
            for artifact in reversed(ctx.artifacts):
                if not _artifact_matches_input_ref(artifact, input_ref):
                    continue
                matched_binding = _resolve_input_binding_from_artifact(artifact, input_ref)
                if matched_binding is not None:
                    ctx.contract_bindings.append(matched_binding)
                    break
            if matched_binding is None and bool(getattr(input_ref, "required", True)):
                ctx.missing_required_contracts.append({
                    "input_name": str(getattr(input_ref, "name", "") or "").strip() or "input",
                    "source_step_id": source_step_id or "n/a",
                    "preferred_medium": str(getattr(input_ref, "preferred_medium", "") or "").strip() or "artifact_result_text",
                    "artifact_role": "derived_from_source_step",
                })

    # Preferred-text and path bindings
    ctx.preferred_text_bindings = []
    ctx.path_bindings = []
    if ctx.action.input_refs:
        for input_ref in ctx.action.input_refs:
            preferred_medium = str(getattr(input_ref, "preferred_medium", "") or "").strip()
            if preferred_medium != "artifact_result_text":
                continue
            for artifact in reversed(ctx.artifacts):
                if not _artifact_matches_input_ref(artifact, input_ref):
                    continue
                if str(artifact.get("artifact_result_text") or "").strip():
                    ctx.preferred_text_bindings.append({
                        "input_name": str(getattr(input_ref, "name", "") or "").strip() or "input",
                        "artifact_name": str(artifact.get("artifact_name") or "").strip() or "artifact",
                    })
                    break
        ctx.path_bindings = [
            item for item in ctx.contract_bindings
            if str(item.get("resolved_medium") or "").strip() == "artifact_result_path"
            and str(item.get("artifact_result_path") or "").strip()
        ]


# ---------------------------------------------------------------------------
# Rule dataclass
# ---------------------------------------------------------------------------

@dataclass
class ToolValidationRule:
    """A single validation rule."""

    name: str
    tool_names: frozenset[str]  # which tool_name values this rule applies to
    check: Callable[[ToolValidationContext], str | None]


# ---------------------------------------------------------------------------
# Individual check functions — file_io rules
# ---------------------------------------------------------------------------

def _check_missing_required_contracts(ctx: ToolValidationContext) -> str | None:
    if ctx.action_name not in {"read", "exec"} or not ctx.missing_required_contracts:
        return None
    summary = ", ".join(
        f"{item['input_name']}({item['preferred_medium']}, source_step_id={item['source_step_id']}, artifact_role={item['artifact_role']})"
        for item in ctx.missing_required_contracts[:5]
    )
    return (
        "Current step is missing required input bindings before file access "
        f"({summary}). Regenerate or resolve the required upstream artifact instead of guessing a file path."
    )


def _check_preferred_text_bindings(ctx: ToolValidationContext) -> str | None:
    if ctx.action_name not in {"read", "exec"} or not ctx.action.input_refs:
        return None
    if ctx.preferred_text_bindings:
        binding_labels = ", ".join(
            f"{item['input_name']}->{item['artifact_name']}"
            for item in ctx.preferred_text_bindings[:5]
        )
        return (
            f"Current step already has resolved artifact_result_text bindings ({binding_labels}). "
            "Use the provided artifact_result_text for reasoning instead of reopening a file."
        )
    return None


def _check_path_binding_mismatch(ctx: ToolValidationContext) -> str | None:
    if ctx.action_name not in {"read", "exec"} or not ctx.action.input_refs:
        return None
    if not ctx.path_bindings:
        return None
    allowed_paths = {
        _normalize_workspace_rel_path(str(item.get("artifact_result_path") or "").strip())
        for item in ctx.path_bindings
    }
    allowed_paths.discard("")
    if ctx.normalized_path and allowed_paths and ctx.normalized_path not in allowed_paths:
        binding_labels = ", ".join(
            str(item.get("artifact_name") or item.get("input_name") or "artifact")
            for item in ctx.path_bindings[:5]
        )
        return (
            f"file_io {ctx.action_name} for '{ctx.path}' does not match the resolved artifact_result_path binding "
            f"({binding_labels}). Use the exact bound artifact_result_path instead of guessing a filename."
        )
    return None


def _check_redundant_same_path_read(ctx: ToolValidationContext) -> str | None:
    if not ctx.path or ctx.action_name not in {"read", "write", "edit", "list"}:
        return None
    current_step_rows = ctx.current_step_results
    latest_same_path_action = ""
    latest_same_path_result: ToolCallResult | None = None
    for row in reversed(current_step_rows):
        if str(getattr(row, "tool_name", "") or "").strip() != "file_io":
            continue
        row_params = getattr(row, "params", {}) or {}
        row_path = str(row_params.get("path") or "").strip()
        if _normalize_workspace_rel_path(row_path) != ctx.normalized_path:
            continue
        latest_same_path_action = str(
            row_params.get("action") or row_params.get("operation") or ""
        ).strip().lower()
        latest_same_path_result = row
        if latest_same_path_action:
            break

    if ctx.action_name == "read" and latest_same_path_action == "read":
        # Handled specially — returns a *success* result, not just a rejection string.
        # We signal this via a special prefix so the dispatcher can build the right result.
        return None  # Handled by _check_redundant_read_reuse instead

    if ctx.action_name == "list" and latest_same_path_action == "list":
        return (
            f"file_io list for '{ctx.path}' is redundant within the same step. "
            "Reuse the current step's existing directory view unless the directory contents changed."
        )

    if ctx.action_name == "write" and latest_same_path_action in {"write", "edit"}:
        return (
            f"file_io write for '{ctx.path}' repeats a prior write/edit in the same step. "
            "Prefer file_io edit for incremental changes, or finish the step if the file is already complete."
        )
    return None


def _check_redundant_read_reuse(ctx: ToolValidationContext) -> ToolCallResult | None:
    """Special rule: redundant same-path read returns a *success* reuse result.

    Returns ``ToolCallResult`` (not ``str``) so the dispatcher can short-circuit.
    This is the only rule that produces a success result.
    """
    if not ctx.path or ctx.action_name != "read":
        return None
    for row in reversed(ctx.current_step_results):
        if str(getattr(row, "tool_name", "") or "").strip() != "file_io":
            continue
        row_params = getattr(row, "params", {}) or {}
        row_path = str(row_params.get("path") or "").strip()
        if _normalize_workspace_rel_path(row_path) != ctx.normalized_path:
            continue
        row_action = str(
            row_params.get("action") or row_params.get("operation") or ""
        ).strip().lower()
        if row_action != "read":
            break
        # Found a prior read of the same path
        if bool(getattr(row, "success", False)):
            reused_metadata = dict(getattr(row, "metadata", {}) or {})
            reused_metadata.update({
                "guard": "llm_act_validation",
                "reused_existing_result": True,
                "reused_reason": "same_step_same_path_read",
            })
            return ToolCallResult(
                tool_name=ctx.tool_name,
                params=ctx.params,
                result=getattr(row, "result", None),
                success=True,
                metadata=reused_metadata,
            )
        return ToolCallResult(
            tool_name=ctx.tool_name,
            params=ctx.params,
            error=(
                f"file_io read for '{ctx.path}' is redundant within the same step. "
                "Reuse the current step's existing read result unless the file changed."
            ),
            success=False,
            metadata={"guard": "llm_act_validation"},
        )
    return None


def _check_read_switches_from_primary(ctx: ToolValidationContext) -> str | None:
    if ctx.action_name != "read":
        return None
    if (
        ctx.current_primary_path not in {"", "."}
        and ctx.normalized_path not in {"", "."}
        and ctx.normalized_path != ctx.current_primary_path
        and _paths_look_semantically_equivalent(ctx.current_primary_path, ctx.normalized_path)
    ):
        return (
            f"file_io read for '{ctx.path}' switches away from the current step primary output "
            f"'{ctx.current_primary_path}'. Reuse the primary output instead of reopening an older same-purpose file."
        )
    return None


def _check_read_revisits_stale_sibling(ctx: ToolValidationContext) -> str | None:
    if ctx.action_name != "read":
        return None
    for row in reversed(ctx.current_step_results):
        if str(getattr(row, "tool_name", "") or "").strip() != "file_io":
            continue
        row_params = getattr(row, "params", {}) or {}
        row_action = str(
            row_params.get("action") or row_params.get("operation") or ""
        ).strip().lower()
        row_path = str(row_params.get("path") or "").strip()
        row_normalized = _normalize_workspace_rel_path(row_path)
        if row_action not in {"write", "edit"}:
            continue
        if row_normalized == ctx.normalized_path:
            continue
        if _paths_look_semantically_equivalent(row_normalized, ctx.normalized_path):
            return (
                f"file_io read for '{ctx.path}' appears to revisit a stale sibling file after "
                f"the current step already wrote '{row_path}'. Reuse the current step output instead "
                "of switching back to an older same-purpose file."
            )
    return None


def _check_write_overlaps_primary(ctx: ToolValidationContext) -> str | None:
    if ctx.action_name != "write":
        return None
    if (
        ctx.current_primary_path not in {"", "."}
        and ctx.normalized_path not in {"", "."}
        and ctx.normalized_path != ctx.current_primary_path
        and _paths_look_semantically_equivalent(ctx.current_primary_path, ctx.normalized_path)
    ):
        return (
            f"file_io write for '{ctx.path}' creates a sibling file that overlaps with the current step primary output "
            f"'{ctx.current_primary_path}'. Continue with file_io edit on the primary output, or finish the step."
        )
    return None


def _check_ambiguous_session_path(ctx: ToolValidationContext) -> str | None:
    if not ctx.path or ctx.path.startswith("/"):
        return None
    basenames = {
        Path(str(item.get("artifact_result_path") or "").strip()).name
        for item in ctx.artifacts
        if str(item.get("artifact_result_path") or "").strip()
    }
    if Path(ctx.path).name not in basenames:
        return None
    if any(
        ctx.path == item.get("workspace_relative_path") or ctx.path == item.get("artifact_result_path")
        for item in ctx.artifacts
    ):
        return None
    matching_paths = [
        str(item.get("artifact_result_path") or "").strip()
        for item in ctx.artifacts
        if Path(str(item.get("artifact_result_path") or "").strip()).name == Path(ctx.path).name
        and str(item.get("artifact_result_path") or "").strip()
    ]
    return (
        f"file_io session path '{ctx.path}' is ambiguous. "
        "Use artifact_result_path from the provided artifact context."
        + (
            " Candidate exact paths: " + "; ".join(matching_paths[:5])
            if matching_paths
            else ""
        )
    )


def _check_report_artifact_type_mismatch(ctx: ToolValidationContext) -> str | None:
    """Advisory-only: logs a warning but never rejects."""
    expected_outputs = [
        str(item).strip().lower()
        for item in (ctx.action.expected_outputs or [])
        if str(item).strip()
    ]
    if not expected_outputs or ctx.action_name != "read":
        return None
    path_values = [ctx.path] if ctx.path else []
    if not path_values:
        return None
    referenced_artifacts = []
    for candidate in path_values:
        for item in ctx.artifacts:
            if candidate in {
                str(item.get("artifact_result_path") or "").strip(),
                str(item.get("workspace_relative_path") or "").strip(),
            }:
                referenced_artifacts.append(item)
    report_like = any(
        ("report" in output) or ("markdown" in output) or ("html" in output) or ("pdf" in output)
        for output in expected_outputs
    )
    if report_like and referenced_artifacts:
        mismatched = [
            item for item in referenced_artifacts
            if str(item.get("artifact_type") or "").strip() not in {"research_report", "analysis_synthesis"}
            and str(item.get("artifact_medium") or "").strip() != "text"
        ]
        if mismatched:
            labels = [
                f"{str(item.get('artifact_name') or item.get('artifact_result_path') or 'artifact')}[{str(item.get('artifact_type') or 'file')}]"
                for item in mismatched[:5]
            ]
            logger.warning(
                "report_like artifact type mismatch (advisory only, not blocking)",
                extra={
                    "step_id": ctx.action.id,
                    "mismatched_artifacts": ", ".join(labels),
                },
            )
    return None  # advisory only


# ---------------------------------------------------------------------------
# code_executor rules
# ---------------------------------------------------------------------------

def _check_code_executor_terminal_wrapper(ctx: ToolValidationContext) -> str | None:
    from src.orchestrator.act_tool_executor import _code_executor_is_terminal_json_wrapper

    code = str(ctx.params.get("code") or "")
    language = str(ctx.params.get("language") or "").strip().lower()
    if not language or not code:
        return None
    if _code_executor_is_terminal_json_wrapper(code):
        return (
            "code_executor was used only to format or print the terminal ACT decision JSON. "
            "Return the terminal JSON directly instead of wrapping it in code."
        )
    return None


def _check_code_executor_embeds_bound_text(ctx: ToolValidationContext) -> str | None:
    from src.orchestrator.act_tool_executor import _code_executor_embeds_bound_text_for_summary_only

    code = str(ctx.params.get("code") or "")
    language = str(ctx.params.get("language") or "").strip().lower()
    if not language or not code:
        return None
    if _code_executor_embeds_bound_text_for_summary_only(
        code=code, action=ctx.action, artifacts=ctx.artifacts,
    ):
        return (
            "code_executor embedded existing artifact_result_text only to summarize or reorganize prior text. "
            "Use the provided artifact_result_text directly in-model instead of copying it into Python."
        )
    return None


def _check_code_executor_relative_tool_runs(ctx: ToolValidationContext) -> str | None:
    code = str(ctx.params.get("code") or "")
    language = str(ctx.params.get("language") or "").strip().lower()
    if not language or not code:
        return None
    suspicious_refs = _re.findall(r"(?<![/\w])(?:\./)?tool_runs/[^\s'\"`]+", code)
    if language in {"python", "javascript"} and suspicious_refs:
        return (
            "code_executor code references tool_runs/... via a relative path. "
            "Python and JavaScript run in isolated tool_runs directories, so prior artifacts must be referenced with artifact_result_path."
        )
    return None


# ---------------------------------------------------------------------------
# semi_browser rules
# ---------------------------------------------------------------------------

def _check_semi_browser_not_justified(ctx: ToolValidationContext) -> str | None:
    has_search_failure = any(
        str(getattr(row, "tool_name", "") or "").strip() == "search" and not bool(getattr(row, "success", False))
        for row in ctx.current_step_results
    )
    has_web_fetch_failure = any(
        str(getattr(row, "tool_name", "") or "").strip() == "web_fetch" and not bool(getattr(row, "success", False))
        for row in ctx.current_step_results
    )
    if has_search_failure and has_web_fetch_failure:
        return None
    if not _step_requires_interactive_browser(ctx.action, ctx.latest_user_text):
        logger.info(
            "semi_browser_not_justified_advisory",
            extra={
                "step_id": str(ctx.action.id or ""),
                "tool_name": ctx.tool_name,
            },
        )
        return None
    return None


# ---------------------------------------------------------------------------
# search rules
# ---------------------------------------------------------------------------

def _check_search_stale_year(ctx: ToolValidationContext) -> str | None:
    from src.orchestrator.act_tool_executor import (
        _get_freshness_validation_flag,
        _is_latest_research_intent,
        _search_query_contains_stale_year,
    )

    query_candidates: list[str] = []
    raw_queries = ctx.params.get("queries")
    if isinstance(raw_queries, list):
        query_candidates.extend(
            str(item or "").strip()
            for item in raw_queries
            if str(item or "").strip()
        )
    # Backward compat: legacy `query` string
    primary_query = str(ctx.params.get("query") or "").strip()
    if primary_query and primary_query not in query_candidates:
        query_candidates.insert(0, primary_query)
    if (
        _get_freshness_validation_flag()
        and _is_latest_research_intent(ctx.latest_user_text)
        and any(_search_query_contains_stale_year(q, today=ctx.today) for q in query_candidates)
    ):
        logger.info(
            "search_stale_year_advisory",
            extra={
                "step_id": str(ctx.action.id or ""),
                "queries": query_candidates[:5],
                "today": ctx.today.strftime("%Y-%m-%d"),
            },
        )
        return (
            "The user asked for latest/current information, but the search query is constrained to older years. "
            "Regenerate the search call with recency-aware queries (today/latest/current) and without stale year limits."
        )
    return None


def _check_search_repeated_failures(ctx: ToolValidationContext) -> str | None:
    from src.orchestrator.act_tool_executor import _has_same_step_search_provider_failures

    if _has_same_step_search_provider_failures(ctx.current_step_results):
        logger.info(
            "search_repeated_failures_advisory",
            extra={
                "step_id": str(ctx.action.id or ""),
                "tool_name": ctx.tool_name,
            },
        )
        return None
    return None


def _check_search_use_queries_param(ctx: ToolValidationContext) -> str | None:
    """Reject search calls that use the deprecated `query` param instead of `queries`."""
    if ctx.params.get("query") and not ctx.params.get("queries"):
        return (
            "The `query` parameter is deprecated. Use `queries` array instead, "
            "e.g. search(queries=[\"your query\"]). Wrap even a single query in the array."
        )
    return None


# ---------------------------------------------------------------------------
# Rule registry — ordered by priority
# ---------------------------------------------------------------------------

_FILE_IO = frozenset({"file_io"})
_CODE_EXECUTOR = frozenset({"code_executor"})
_SEMI_BROWSER = frozenset({"semi_browser"})
_SEARCH = frozenset({"search"})

TOOL_VALIDATION_RULES: list[ToolValidationRule] = [
    # file_io — contract / binding checks (highest priority)
    ToolValidationRule("missing_required_contracts", _FILE_IO, _check_missing_required_contracts),
    ToolValidationRule("preferred_text_bindings", _FILE_IO, _check_preferred_text_bindings),
    ToolValidationRule("path_binding_mismatch", _FILE_IO, _check_path_binding_mismatch),
    # file_io — same-path redundancy
    ToolValidationRule("redundant_same_path_ops", _FILE_IO, _check_redundant_same_path_read),
    # file_io — primary-output drift
    ToolValidationRule("read_switches_from_primary", _FILE_IO, _check_read_switches_from_primary),
    ToolValidationRule("read_revisits_stale_sibling", _FILE_IO, _check_read_revisits_stale_sibling),
    ToolValidationRule("write_overlaps_primary", _FILE_IO, _check_write_overlaps_primary),
    # file_io — ambiguous path
    ToolValidationRule("ambiguous_session_path", _FILE_IO, _check_ambiguous_session_path),
    # file_io — advisory (never rejects)
    ToolValidationRule("report_artifact_type_mismatch", _FILE_IO, _check_report_artifact_type_mismatch),
    # code_executor
    ToolValidationRule("code_executor_terminal_wrapper", _CODE_EXECUTOR, _check_code_executor_terminal_wrapper),
    ToolValidationRule("code_executor_embeds_bound_text", _CODE_EXECUTOR, _check_code_executor_embeds_bound_text),
    ToolValidationRule("code_executor_relative_tool_runs", _CODE_EXECUTOR, _check_code_executor_relative_tool_runs),
    # semi_browser
    ToolValidationRule("semi_browser_not_justified", _SEMI_BROWSER, _check_semi_browser_not_justified),
    # search
    ToolValidationRule("search_stale_year", _SEARCH, _check_search_stale_year),
    ToolValidationRule("search_repeated_failures", _SEARCH, _check_search_repeated_failures),
]


# ---------------------------------------------------------------------------
# Public entry point
# ---------------------------------------------------------------------------

def validate_act_tool_call(
    *,
    action: PlanStep,
    prior_results: list[ToolCallResult],
    current_step_results: list[ToolCallResult] | None,
    runtime_context: Any | None,
    latest_user_text: str = "",
    today: datetime | None = None,
) -> ToolCallResult | None:
    """Run all applicable validation rules against a single tool call.

    Returns a ``ToolCallResult`` rejection (or reuse) if any rule fires,
    otherwise ``None`` (= call is allowed).
    """
    params = action.params if isinstance(action.params, dict) else {}
    tool_name = str(action.tool or "").strip()
    today_val = today or datetime.now(timezone.utc)

    ctx = ToolValidationContext(
        action=action,
        tool_name=tool_name,
        params=params,
        prior_results=prior_results,
        current_step_results=list(current_step_results or []),
        runtime_context=runtime_context,
        latest_user_text=latest_user_text,
        today=today_val,
    )

    # Prepare derived context for file_io rules
    if tool_name == "file_io":
        _prepare_file_io_context(ctx)
    elif tool_name in {"code_executor", "search"}:
        ctx.artifacts = _build_act_artifact_context(prior_results, runtime_context)

    # Special case: redundant read reuse (returns success ToolCallResult)
    if tool_name == "file_io" and ctx.path and ctx.action_name == "read":
        reuse_result = _check_redundant_read_reuse(ctx)
        if reuse_result is not None:
            return reuse_result

    # Run declarative rules
    for rule in TOOL_VALIDATION_RULES:
        if tool_name not in rule.tool_names:
            continue
        reason = rule.check(ctx)
        if reason:
            # Attach extra metadata for ambiguous_session_path
            extra_meta: dict[str, Any] = {"guard": "llm_act_validation"}
            if rule.name == "ambiguous_session_path" and tool_name == "file_io":
                matching_paths = [
                    str(item.get("artifact_result_path") or "").strip()
                    for item in ctx.artifacts
                    if Path(str(item.get("artifact_result_path") or "").strip()).name == Path(ctx.path).name
                    and str(item.get("artifact_result_path") or "").strip()
                ]
                if matching_paths:
                    extra_meta["candidate_exact_paths"] = matching_paths[:10]
            if rule.name == "code_executor_relative_tool_runs":
                code = str(ctx.params.get("code") or "")
                suspicious_refs = _re.findall(r"(?<![\\w/])(?:\\./)?tool_runs/[^\\s'\"`]+", code)
                if suspicious_refs:
                    extra_meta["suspicious_paths"] = suspicious_refs[:10]
            return ToolCallResult(
                tool_name=tool_name,
                params=params,
                error=reason,
                success=False,
                metadata=extra_meta,
            )

    return None
