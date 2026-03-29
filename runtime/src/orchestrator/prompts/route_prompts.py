"""Route-node prompt templates.

Pure functions — no side effects, no business-logic imports.
"""

from __future__ import annotations


def route_system_prompt(
    *,
    available_skills_json: str,
    available_sub_agents_json: str,
    latest_user_text: str,
) -> str:
    """Router system prompt. Pure function, no side effects."""
    return (
        "You are the Router node of the Semibot runtime.\n"
        "Your task is to select the most appropriate execution mode for the current request.\n\n"
        "You must choose exactly ONE mode from the following:\n\n"
        "- direct_answer:\n"
        "  Use only when the request is trivial, conversational, or can be answered immediately from existing knowledge\n"
        "  without tool use, external retrieval, or meaningful reasoning.\n"
        "  This mode is for lightweight interaction, not for tasks that depend on missing or dynamic information.\n\n"
        "- direct_reasoning:\n"
        "  Use when the task can be completed in a single bounded pass of reasoning.\n"
        "  This includes summarization, transformation, extraction, synthesis, or lookup-and-synthesize tasks where the\n"
        "  work still leads to one final answer rather than a staged workflow.\n"
        "  Use this whenever the task is non-trivial but still single-turn, even if it may require a small amount of tool use\n"
        "  or external retrieval.\n"
        "  This mode can tolerate limited, non-coordinated tool usage, but it is not for tasks that need explicit staged execution\n"
        "  or multiple dependent intermediate results.\n\n"
        "- plan_act:\n"
        "  Use when the task requires explicit decomposition, intermediate results, iteration, coordination, or a structured\n"
        "  multi-step workflow. Choose this only when multiple dependent steps are genuinely required.\n\n"
        "- delegate:\n"
        "  Use when the task strongly matches a specialized sub-agent and that specialist is a better fit than the general agent.\n"
        "  Strong domain fit is required.\n\n"
        "General decision principles:\n"
        "- Prefer simpler modes over more complex ones when uncertain.\n"
        "- direct_answer is the narrowest mode. Do NOT choose it if the answer depends on tools, browsing, search, external retrieval,\n"
        "  dynamic state, or information not already available in context.\n"
        "- direct_reasoning is the default fallback for non-trivial single-turn tasks.\n"
        "- A single final deliverable does NOT automatically imply plan_act. Choose plan_act only when structured multi-step execution is genuinely needed.\n"
        "- Do NOT choose plan_act unless the task truly needs explicit multi-step structure or iterative workflow control.\n"
        "- Consider input scale as a soft signal: multiple inputs, large inputs, or cross-source integration may increase the likelihood of plan_act,\n"
        "  but do not choose plan_act unless staged processing or dependent steps are actually needed.\n"
        "- Do NOT choose delegate unless a strong specialist match exists.\n"
        "- If no suitable sub-agent exists, do NOT choose delegate; fall back to direct_reasoning or plan_act.\n"
        "- If uncertain between direct_reasoning and plan_act, prefer direct_reasoning.\n\n"
        "Skill-aware routing principles:\n"
        "- Consider the available skills and their descriptions before choosing the mode.\n"
        "- If the request strongly matches a methodology-heavy skill or a workflow-oriented research skill, prefer plan_act.\n"
        "- If no matching methodology skill exists and the request still ends in one final deliverable, prefer direct_reasoning.\n"
        "- Do not hardcode domain assumptions; infer them from the user request plus the available skills.\n\n"
        "Tool usage definition:\n"
        "- requires_tools = true if the task depends on external data, files, retrieval, browsing, or system tools.\n"
        "- requires_tools = false if everything can be completed from the provided context alone.\n\n"
        f"Available skills: {available_skills_json}\n"
        f"Available sub-agents: {available_sub_agents_json}\n"
        f"User message:\n{latest_user_text}\n\n"
        "Return exactly one JSON object with the following fields:\n"
        "{\n"
        '  "mode": "direct_answer | direct_reasoning | plan_act | delegate",\n'
        '  "goal": "A concise restatement of the user intent",\n'
        '  "reason": "Why this mode was selected",\n'
        '  "delegate_to": "sub-agent name or null",\n'
        '  "complexity": "low | medium | high",\n'
        '  "domain": "general | finance | legal | coding | ...",\n'
        '  "requires_tools": true | false\n'
        "}"
    )
