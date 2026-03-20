"""Centralized context budget definitions for LLM call phases.

Each phase (plan, act-tool, act-terminal) has a budget that controls how much
context is sent to the LLM.  Individual context builders read these budgets
instead of using scattered magic numbers.

All limits are in *characters* (not tokens).  A rough 1:4 char-to-token ratio
is assumed; the actual ratio varies by model and language.
"""

from __future__ import annotations

import os
from dataclasses import dataclass


def _env_int(key: str, default: int) -> int:
    raw = os.getenv(key, "").strip()
    if raw:
        try:
            return int(raw)
        except ValueError:
            pass
    return default


@dataclass(frozen=True, slots=True)
class ContextBudget:
    """Per-phase context budget."""

    # System prompt (base rules + step context)
    max_system_prompt_chars: int
    # Conversation / transcript history
    max_history_chars: int
    max_history_messages: int
    max_history_per_message_chars: int
    # Artifact context
    max_artifact_items: int
    max_artifact_text_chars: int
    # Memory
    max_memory_chars: int
    # Skill index (plan only)
    max_skill_index_items: int = 15
    max_skill_index_chars: int = 8000
    max_skill_desc_chars: int = 200
    # Skill MD body (plan only)
    max_skill_md_chars: int = 20000


# ---------------------------------------------------------------------------
# Phase budgets
# ---------------------------------------------------------------------------

PLAN_BUDGET = ContextBudget(
    max_system_prompt_chars=24000,
    max_history_chars=6000,
    max_history_messages=6,
    max_history_per_message_chars=1200,
    max_artifact_items=8,
    max_artifact_text_chars=300,
    max_memory_chars=6000,
    max_skill_index_items=10,
    max_skill_index_chars=6000,
    max_skill_desc_chars=180,
    max_skill_md_chars=16000,
)

ACT_TOOL_BUDGET = ContextBudget(
    max_system_prompt_chars=24000,
    max_history_chars=24000,
    max_history_messages=_env_int("SEMIBOT_ACT_MAX_HISTORY_MESSAGES", 20),
    max_history_per_message_chars=3000,
    max_artifact_items=10,
    max_artifact_text_chars=400,
    max_memory_chars=2000,
)

ACT_TERMINAL_BUDGET = ContextBudget(
    max_system_prompt_chars=16000,
    max_history_chars=8000,
    max_history_messages=6,
    max_history_per_message_chars=2000,
    max_artifact_items=8,
    max_artifact_text_chars=300,
    max_memory_chars=1000,
)

PLAN_COMPACT_BUDGET = ContextBudget(
    max_system_prompt_chars=12000,
    max_history_chars=3000,
    max_history_messages=4,
    max_history_per_message_chars=800,
    max_artifact_items=6,
    max_artifact_text_chars=200,
    max_memory_chars=1200,
    max_skill_index_items=8,
    max_skill_index_chars=4000,
    max_skill_desc_chars=150,
    max_skill_md_chars=8000,
)


def get_act_budget(phase: str) -> ContextBudget:
    """Return the appropriate ACT budget for the given phase."""
    if phase == "terminal":
        return ACT_TERMINAL_BUDGET
    return ACT_TOOL_BUDGET
