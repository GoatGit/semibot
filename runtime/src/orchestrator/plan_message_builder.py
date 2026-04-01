"""Plan loop message construction: system prompt, history, skill index, planning state."""

import json
import os
from pathlib import Path
from typing import Any

from src.orchestrator.context_budget import PLAN_BUDGET, _env_int
from src.skills.skill_resource_locator import locate_skill_md
from src.utils.logging import get_logger

logger = get_logger(__name__)

_PLANNER_SKILL_MD_MAX_CHARS = PLAN_BUDGET.max_skill_md_chars
_PLANNER_MEMORY_MAX_CHARS = PLAN_BUDGET.max_memory_chars
_PLANNER_HISTORY_USER_MAX_CHARS = PLAN_BUDGET.max_history_per_message_chars
_PLANNER_HISTORY_ASSISTANT_MAX_CHARS = 800
_PLANNER_STATE_TEXT_MAX_CHARS = 400


def _truncate_planner_text(text: str, limit: int) -> str:
    normalized = str(text or "").strip()
    if len(normalized) <= limit:
        return normalized
    return normalized[:limit] + "...[truncated]"


def _compact_planner_value(value: Any, *, depth: int = 0) -> Any:
    if depth >= 5:
        return "[truncated]"
    if isinstance(value, str):
        return _truncate_planner_text(value, _PLANNER_STATE_TEXT_MAX_CHARS)
    if isinstance(value, (int, float, bool)) or value is None:
        return value
    if isinstance(value, list):
        items = [_compact_planner_value(item, depth=depth + 1) for item in value[:8]]
        if len(value) > 8:
            items.append(f"...[{len(value) - 8} more items truncated]")
        return items
    if isinstance(value, dict):
        compact: dict[str, Any] = {}
        for idx, (key, item) in enumerate(value.items()):
            if idx >= 24:
                compact["__truncated__"] = f"{len(value) - 24} more keys truncated"
                break
            compact[str(key)] = _compact_planner_value(item, depth=depth + 1)
        return compact
    return str(value)


def _latest_user_text_from_messages(messages: list[dict[str, Any]]) -> str:
    for message in reversed(messages):
        if str(message.get("role") if isinstance(message, dict) else getattr(message, "role", "")) == "user":
            return str(message.get("content") if isinstance(message, dict) else getattr(message, "content", ""))
    return ""


def _load_skill_md_for_planner(skill_item: dict[str, Any] | None) -> tuple[str, bool]:
    if not isinstance(skill_item, dict):
        return "", False
    content, _source = locate_skill_md(skill_item)
    if content:
        if len(content) <= _PLANNER_SKILL_MD_MAX_CHARS:
            return content, False
        return content[:_PLANNER_SKILL_MD_MAX_CHARS], True
    skill_name = str(skill_item.get("id") or skill_item.get("name") or "").strip()
    if not skill_name:
        return "", False
    try:
        skills_root = Path(os.getenv("SEMIBOT_SKILLS_PATH", "~/.semibot/skills")).expanduser().resolve()
        skill_root = (skills_root / skill_name).resolve()
        if skill_root != skills_root and skills_root not in skill_root.parents:
            return "", False
        target = (skill_root / "SKILL.md").resolve()
        if target != skill_root and skill_root not in target.parents:
            return "", False
        if not target.exists() or not target.is_file():
            return "", False
        raw = target.read_text(encoding="utf-8", errors="replace")
        if len(raw) <= _PLANNER_SKILL_MD_MAX_CHARS:
            return raw, False
        return raw[:_PLANNER_SKILL_MD_MAX_CHARS], True
    except Exception:
        return "", False


def _build_plan_loop_system_prompt(
    *,
    available_execution_capabilities: dict[str, str],
    sub_agents_summary: str,
    agent_system_prompt: str,
    current_date: str | None = None,
    current_weekday: str | None = None,
    current_timezone: str | None = None,
) -> str:
    from src.orchestrator.prompts.plan_prompts import planner_system_prompt
    from src.orchestrator.state import resolve_time_context

    fallback_date, fallback_weekday, fallback_timezone = resolve_time_context()
    display_date = str(current_date or "").strip() or fallback_date
    display_weekday = str(current_weekday or "").strip() or fallback_weekday
    display_timezone = str(current_timezone or "").strip() or fallback_timezone
    prompt = planner_system_prompt(
        display_date=display_date,
        display_weekday=display_weekday,
        display_timezone=display_timezone,
        available_execution_capabilities=available_execution_capabilities,
        sub_agents_summary=sub_agents_summary,
    )
    if agent_system_prompt:
        return f"{agent_system_prompt}\n\n---\n\n{prompt}"
    return prompt


_MAX_SKILLS_IN_PROMPT = _env_int("SEMIBOT_MAX_SKILLS_IN_PROMPT", PLAN_BUDGET.max_skill_index_items)
_MAX_SKILLS_PROMPT_CHARS = _env_int("SEMIBOT_MAX_SKILLS_PROMPT_CHARS", PLAN_BUDGET.max_skill_index_chars)
_MAX_SKILL_DESC_CHARS = _env_int("SEMIBOT_MAX_SKILL_DESC_CHARS", PLAN_BUDGET.max_skill_desc_chars)


def _build_plan_loop_messages(
    *,
    state_messages: list[dict[str, Any]],
    original_goal: str,
    current_round_goal: str,
    execution_state: dict[str, Any],
    prior_plan_summary: dict[str, Any],
    available_execution_capabilities: dict[str, str],
    planning_limits: dict[str, Any],
    runtime_context: Any | None,
    memory_context: str,
    failure_reflection: str,
    sub_agents_for_planner: list[dict[str, Any]],
    agent_system_prompt: str,
    current_date: str | None = None,
    current_weekday: str | None = None,
    current_timezone: str | None = None,
    planner_tool_catalog_cards: list[dict[str, Any]] | None = None,
    planner_core_tool_schemas: list[dict[str, Any]] | None = None,
) -> list[dict[str, Any]]:
    from src.orchestrator.nodes_respond import _infer_delivery_language
    from src.skills.skill_index_prompt import (
        build_skill_index_entries,
        format_skills_for_prompt,
        sort_skill_index_entries,
    )

    def _is_planner_safe_history_message(role: str, content: str) -> bool:
        text = str(content or "").strip()
        if not text:
            return False
        if role == "user":
            return True
        lowered = text.lower()
        blocked_patterns = (
            "```json",
            "\"tool_calls\"",
            "\"type\":\"execution_",
            "\"type\": \"execution_",
            "<function_calls>",
            ">functions.",
            "i encountered an error:",
            "planning failed:",
            "act inner loop exceeded",
            "已生成文件：",
            "已生成主报告文件：",
            "已生成文本结果：",
            "任务已完成。",
        )
        return not any(pattern in lowered for pattern in blocked_patterns)

    history_messages = []
    user_delivery_language = _infer_delivery_language(_latest_user_text_from_messages(state_messages))
    for message in state_messages:
        role = str(message.get("role") or "")
        if role not in {"user", "assistant"}:
            continue
        raw_content = str(message.get("content") or "")
        content = _truncate_planner_text(
            raw_content,
            _PLANNER_HISTORY_USER_MAX_CHARS if role == "user" else _PLANNER_HISTORY_ASSISTANT_MAX_CHARS,
        )
        if not _is_planner_safe_history_message(role, content):
            continue
        history_messages.append({"role": role, "content": content})
    history_was_truncated = False
    if len(history_messages) > 6:
        history_messages = history_messages[-6:]
        history_was_truncated = True

    if not sub_agents_for_planner:
        sub_agents_summary = "(none)"
    else:
        sub_agents_summary = "\n".join(
            (
                f"- id: {item.get('id')}\n"
                f"  name: {item.get('name')}\n"
                f"  description: {item.get('description') or ''}"
            )
            for item in sub_agents_for_planner
        )
    planning_messages: list[dict[str, Any]] = [
        {
            "role": "system",
            "content": _build_plan_loop_system_prompt(
                available_execution_capabilities=available_execution_capabilities,
                sub_agents_summary=sub_agents_summary,
                agent_system_prompt=agent_system_prompt,
                current_date=current_date,
                current_weekday=current_weekday,
                current_timezone=current_timezone,
            ),
        }
    ]
    metadata = getattr(runtime_context, "metadata", None)
    catalog_cards = [item for item in (planner_tool_catalog_cards or []) if isinstance(item, dict)]
    if catalog_cards:
        planning_messages.append(
            {
                "role": "system",
                "content": "== Tool Catalog Cards ==\n" + json.dumps(_compact_planner_value(catalog_cards[:24]), ensure_ascii=False, indent=2),
            }
        )
    core_tool_schemas = [item for item in (planner_core_tool_schemas or []) if isinstance(item, dict)]
    if core_tool_schemas:
        planning_messages.append(
            {
                "role": "system",
                "content": "== Core Tool Schemas ==\n" + json.dumps(_compact_planner_value(core_tool_schemas[:8]), ensure_ascii=False, indent=2),
            }
        )
    raw_skill_index = metadata.get("skill_index") if isinstance(metadata, dict) else None
    if isinstance(raw_skill_index, list):
        entries = build_skill_index_entries([row for row in raw_skill_index if isinstance(row, dict)])
        if entries:
            explicit_paths: list[str] = []
            if isinstance(metadata, dict):
                for key in ("active_paths", "_active_paths", "target_files"):
                    raw_paths = metadata.get(key)
                    if not isinstance(raw_paths, list):
                        continue
                    explicit_paths.extend(
                        str(item).strip()
                        for item in raw_paths
                        if str(item).strip()
                    )
            user_text = _latest_user_text_from_messages(state_messages)
            ordered = sort_skill_index_entries(
                entries,
                user_text=user_text,
                active_paths=explicit_paths,
                prior_selected_skill=str(prior_plan_summary.get("selected_skill") or "").strip() or None,
            )
            _replan_selected_skill = str(prior_plan_summary.get("selected_skill") or "").strip()
            if _replan_selected_skill:
                _selected_entries = [e for e in ordered if e.skill_id == _replan_selected_skill]
                _other_ids = [e.skill_id for e in ordered if e.skill_id != _replan_selected_skill]
                if _selected_entries:
                    _skill_content = format_skills_for_prompt(
                        _selected_entries,
                        max_skills=1,
                        max_chars=_MAX_SKILLS_PROMPT_CHARS,
                        max_desc_chars=_MAX_SKILL_DESC_CHARS,
                    )
                    if _other_ids:
                        _skill_content += "\n<other_available_skills>" + ", ".join(_other_ids[:30]) + "</other_available_skills>"
                    planning_messages.append({"role": "system", "content": _skill_content})
                else:
                    logger.warning(
                        "replan_selected_skill_not_in_index",
                        extra={"selected_skill": _replan_selected_skill, "available_count": len(ordered)},
                    )
                    planning_messages.append(
                        {
                            "role": "system",
                            "content": format_skills_for_prompt(
                                ordered,
                                max_skills=_MAX_SKILLS_IN_PROMPT,
                                max_chars=_MAX_SKILLS_PROMPT_CHARS,
                                max_desc_chars=_MAX_SKILL_DESC_CHARS,
                            ),
                        }
                    )
            else:
                planning_messages.append(
                    {
                        "role": "system",
                        "content": format_skills_for_prompt(
                            ordered,
                            max_skills=min(_MAX_SKILLS_IN_PROMPT, 15),
                            max_chars=_MAX_SKILLS_PROMPT_CHARS,
                            max_desc_chars=_MAX_SKILL_DESC_CHARS,
                        ),
                    }
                )
    planning_messages.append(
        {
            "role": "system",
            "content": "== Planning State ==\n"
            + json.dumps(
                {
                    "original_goal": original_goal,
                    "current_round_goal": current_round_goal,
                    "user_delivery_language": user_delivery_language,
                    "execution_state": _compact_planner_value(execution_state),
                    "prior_plan_summary": _compact_planner_value(prior_plan_summary),
                    "planning_limits": _compact_planner_value(planning_limits),
                },
                ensure_ascii=False,
                indent=2,
            ),
        }
    )
    if memory_context:
        planning_messages.append(
            {
                "role": "system",
                "content": f"== Memory Context ==\n{_truncate_planner_text(memory_context, _PLANNER_MEMORY_MAX_CHARS)}",
            }
        )
    if history_was_truncated:
        planning_messages.append(
            {
                "role": "system",
                "content": (
                    "== Conversation History Window ==\n"
                    "Only the most recent user/assistant turns are included below. "
                    "Use the structured execution state block above as the primary source of truth."
                ),
            }
        )
    planning_messages.extend(history_messages)
    if failure_reflection:
        planning_messages.append({"role": "system", "content": failure_reflection})
    return planning_messages
