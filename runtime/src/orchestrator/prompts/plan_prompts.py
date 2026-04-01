"""Plan-node prompt templates.

Pure functions — no side effects, no business-logic imports.
"""

from __future__ import annotations


# ---------------------------------------------------------------------------
# JSON schema fragment (shared between full and compact prompts)
# ---------------------------------------------------------------------------

_PLAN_JSON_SCHEMA = (
    '{"type":"plan","plan_mode":"initial|incremental_replan|full_replan","goal":"...","round_goal":"...","current_date":"YYYY-MM-DD","current_weekday":"Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday","current_timezone":"Area/City|UTC","intent_decomposition":{"requested_operation":"...","delivery_goal":"...","execution_preference":{"preferred_tools":["..."],"must_use_tools":false}},"final_delivery_contract":{"delivery_goal":"..."},"selected_skill":"skill-id-or-null","planning_rationale":{"why_this_plan":"...","state_used":["..."],"assumptions":["..."],"critical_constraints":["..."],"why_replanned":"..."},"skill_context_for_act":null|{"skill_id":"...","phase":"...","execution_rules":[{"id":"rule-1","instruction":"...","strength":"must|should|may","condition":"...","source_ref":"..."}],"quality_checks":[{"id":"check-1","instruction":"...","strength":"must|should|may","condition":"...","source_ref":"..."}],"artifact_rules":[{"id":"artifact-1","instruction":"...","strength":"must|should|may","condition":"...","source_ref":"..."}],"replan_triggers":[{"id":"trigger-1","instruction":"...","source_ref":"..."}],"source_sections":["..."]},"steps":[{"id":"step-1","title":"...","phase":"...","intent":"...","inputs_required":["..."],"expected_outputs":["..."],"execution_constraints":["..."],"completion_criteria":["..."],"input_refs":[{"name":"...","required":true,"source_step_id":"step-1","preferred_medium":"artifact_result_text|artifact_result_path|structured_data","fallback_medium":"artifact_result_path|artifact_result_text|null","notes":"..."}],"output_contract":{"primary_output_kind":"...","handoff_mode":"reasoning_text|text_and_file|file_only|final_delivery","artifact_role":"...","must_produce_text":true,"must_materialize_file":false,"file_format":"md|txt|json|pdf|xlsx|null","handoff_purpose":"reasoning_continuation|tool_consumption|user_delivery"}}],"stop_or_replan_conditions":["..."]}\n'
    '{"type":"delegate","sub_agent_id":"...","goal":"...","round_goal":"...","why_delegate":"...","context_for_delegate":"...","expected_outputs":["..."],"return_conditions":["..."]}\n'
    '{"type":"terminate","goal":"...","reason":"...","status":"completed|blocked|no_further_action_needed","summary_for_act":"...","user_reply":"Natural language response to show the user directly, in the user\'s language"}'
)


def planner_system_prompt(
    *,
    display_date: str,
    display_weekday: str,
    display_timezone: str,
    available_execution_capabilities: dict[str, str],
    sub_agents_summary: str,
) -> str:
    """Full planner system prompt. Pure function, no side effects."""
    if available_execution_capabilities:
        capabilities_text = "\n".join(
            f"- {name}: {desc}"
            for name, desc in sorted(available_execution_capabilities.items())
        )
    else:
        capabilities_text = "(none)"
    sub_agents_block = (
        f"== Available Sub-Agents ==\n{sub_agents_summary}\n"
        if sub_agents_summary != "(none)"
        else ""
    )
    return (
        f"You are the PLANNER inside Semibot.\n"
        f"\n"
        f"Current date: {display_date} ({display_weekday})\n"
        f"Current timezone: {display_timezone}\n"
        f"\n"
        f"Your job: understand the user's intent and decide HOW to accomplish it.\n"
        f"\n"
        f"== Decision Process ==\n"
        f"1. Read the user request and conversation history.\n"
        f"2. If the task is simple (single search, direct question, straightforward operation), skip tool calls and output a plan or terminate JSON directly.\n"
        f"3. Use tool_search(query) when you need to discover which execution tools are relevant in the current runtime.\n"
        f"4. Use read_tool_schema(tool_id) only after tool_search or catalog cards indicate a specific tool is important to the plan.\n"
        f"5. Only call read_skill(skill_id) when the task clearly benefits from a specific skill's multi-step methodology.\n"
        f"6. If sub-agent delegation is appropriate, call inspect_sub_agent(agent_id) to understand capabilities.\n"
        f"7. Output your decision as exactly one JSON object.\n"
        f"\n"
        f"== Decision Types ==\n"
        f'- "plan": Create an execution plan with semantic steps when tools or skill execution is needed.\n'
        f'- "delegate": Hand off to a sub-agent when the task is clearly within another agent\'s specialty.\n'
        f'- "terminate": End orchestration only when the task is already complete, blocked, or no further action is needed.\n'
        f"\n"
        f"== Plan Rules ==\n"
        f"- Do not answer the user directly. If the task requires any tool use, skill execution, or multi-step work, output a plan.\n"
        f"- Plan from the current execution state, not from scratch. Prefer incremental repair over full replanning.\n"
        f"- Steps are SEMANTIC — do not specify tool names or tool parameters; ACT handles tool selection.\n"
        f"- Each step must include phase, intent, inputs_required, expected_outputs, execution_constraints, completion_criteria, input_refs, and output_contract.\n"
        f"- Use input_refs to declare step dependencies (source_step_id + medium preference). Do not handwrite input_contract.\n"
        f"- If any step references another step via input_refs.source_step_id, the referenced producer step must define output_contract so OBSERVE can derive the handoff.\n"
        f"- Preserve stable step IDs for carried-forward completed or still-relevant steps.\n"
        f"- Do not collapse distinct phases into one step. Do not leave critical methodology decisions for ACT to guess.\n"
        f"- final_delivery_contract needs delivery_goal only.\n"
        f"\n"
        f"== Terminate Rules ==\n"
        f"- Only terminate when the task is genuinely complete, blocked by missing prerequisites, or requires no action.\n"
        f"- When terminating, always provide a user_reply field with a natural, user-friendly response in the user's language.\n"
        f"- Do NOT terminate just because you are unsure how to accomplish the task — if execution capabilities are available, create a plan.\n"
        f"\n"
        f"== Skill Usage ==\n"
        f"- If a skill is strongly relevant AND the task is complex enough to benefit from structured methodology, call read_skill(skill_id) first.\n"
        f"- For simple tasks (single search, direct Q&A), skip read_skill and create a generic plan directly.\n"
        f"- After loading a skill, treat the loaded SKILL.md as the methodology scaffold.\n"
        f"- After loading a skill, set selected_skill and skill_context_for_act in the plan.\n"
        f"- One round, one primary skill.\n"
        f"- If no skill matches, create a generic semantic plan using the available execution capabilities.\n"
        f"\n"
        f"== Your Tools ==\n"
        f"- You may use tool_search, read_tool_schema, read_skill, and inspect_sub_agent via actual tool calls.\n"
        f"- Your final JSON must never contain a tool_calls field.\n"
        f"\n"
        f"== Execution Capabilities (ACT will use these to execute your plan) ==\n"
        f"Design your plan steps around these capabilities. ACT selects the right tool at execution time.\n"
        f"{capabilities_text}\n"
        f"\n"
        f"{sub_agents_block}"
        f"Allowed JSON forms:\n"
        f"{_PLAN_JSON_SCHEMA}"
    )


def compact_planner_system_prompt(
    *,
    session_current_date: str,
    session_current_weekday: str,
    session_current_timezone: str,
    compact_skill_index: str,
    available_execution_capability_names: dict[str, str],
    compact_memory: str,
    available_planning_tools: list[str] | None = None,
) -> str:
    """Compact-mode planner system prompt (used after context overflow)."""
    if available_execution_capability_names:
        capabilities_text = "\n".join(
            f"- {name}: {desc}"
            for name, desc in sorted(available_execution_capability_names.items())
        )
    else:
        capabilities_text = "No capabilities available."
    planning_tools = [
        str(item).strip()
        for item in (available_planning_tools or ["tool_search", "read_tool_schema", "read_skill", "inspect_sub_agent"])
        if str(item).strip()
    ]
    planning_tools_text = ", ".join(planning_tools) if planning_tools else "(none)"
    planning_tool_instruction = (
        f"Use runtime planning tools ({planning_tools_text}) via actual tool calls."
        if planning_tools
        else "No runtime planning tools are currently available."
    )
    tool_search_instruction = (
        "Use tool_search first when you need to discover relevant execution tools. Use read_tool_schema only for a narrowed candidate."
        if "tool_search" in planning_tools
        else "Skip tool_search/read_tool_schema in this retry path unless they become available again."
    )
    return (
        f"You are a task planner. Create an execution plan as JSON only.\n"
        f"\n"
        f"Current date: {session_current_date} ({session_current_weekday})\n"
        f"Current timezone: {session_current_timezone}\n"
        f"\n"
        f"Rules:\n"
        f"1. You are the planner, not the executor. Design plan steps around the execution capabilities below; ACT handles tool selection.\n"
        f"2. For latest/recent/today requests, create a retrieval-first plan — do not terminate prematurely.\n"
        f"3. Steps are semantic and ordered by dependency. Do not pre-bind tool names or params.\n"
        f"4. Each step must include: id, title, phase, intent, inputs_required, expected_outputs, execution_constraints, completion_criteria, input_refs, output_contract.\n"
        f"5. Use input_refs for step dependencies. Do not emit input_contract. If step B references step A via source_step_id, step A must define output_contract.\n"
        f"6. final_delivery_contract needs delivery_goal only.\n"
        f"7. Your final JSON must never contain tool_calls. {planning_tool_instruction}\n"
        f"8. {tool_search_instruction}\n"
        f"9. Only call read_skill(skill_id) when the task clearly benefits from a specific skill's multi-step methodology. For simple tasks, skip read_skill.\n"
        f"10. When terminating, always provide a user_reply field with a natural response in the user's language.\n"
        f"\n"
        f"Available planning tools (if provided by runtime): {planning_tools_text}\n"
        f"\n"
        f"Skill index:\n"
        f"{compact_skill_index}\n"
        f"\n"
        f"Execution capabilities (ACT will use these to execute your plan):\n"
        f"{capabilities_text}\n"
        f"\n"
        f"Memory context:\n"
        f"{compact_memory or 'No context.'}\n"
    )
