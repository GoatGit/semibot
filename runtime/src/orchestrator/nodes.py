"""State nodes for the LangGraph state machine.

Each node is a function that takes the current AgentState and returns
an updated state. These nodes implement the core Agent execution logic:

- START: Initialize context and load memories
- PLAN: Parse intent and generate execution plan
- ACT: Execute tools/skills
- DELEGATE: Delegate to SubAgents
- OBSERVE: Evaluate results and decide next step
- REFLECT: Summarize and store learnings
- RESPOND: Generate final response
"""

import json
import time
from datetime import datetime
from typing import Any

from src.constants import MAX_REPLAN_ATTEMPTS, REPLAN_RESULT_MAX_CHARS
from src.orchestrator.execution import (
    parse_plan_response,
    parse_reflection_response,
)
from src.orchestrator.state import (
    AgentState,
    ExecutionPlan,
    Message,
    PlanStep,
    ReflectionResult,
    ToolCallResult,
)
from src.utils.logging import get_logger

logger = get_logger(__name__)


import re as _re

_LATEST_INTENT_PATTERNS = (
    "最新",
    "最近",
    "today",
    "todays",
    "today's",
    "latest",
    "recent",
    "news",
    "近况",
    "动态",
)

_SEARCH_TOOL_KEYWORDS = (
    "search",
    "tavily",
    "exa",
    "bailian",
    "serp",
    "google",
    "bing",
    "duckduckgo",
)

_TIME_SERIES_PATTERNS = (
    r"近\s*(\d{1,3})\s*年",
    r"过去\s*(\d{1,3})\s*年",
    r"last\s*(\d{1,3})\s*years?",
)

_FINANCE_RESEARCH_PATTERNS = (
    "股票",
    "股价",
    "港股",
    "美股",
    "a股",
    "财报",
    "估值",
    "目标价",
    "research",
    "stock",
    "equity",
    "ticker",
)

_FINANCE_NOISE_DOMAIN_PATTERNS = (
    "t.me/",
    "telegram.",
    "xueqiu.com",
    "gswarrants.com.hk",
    "talkmoney.com.hk",
    "weixin.qq.com",
    "mp.weixin.qq.com",
    "zhuanlan.zhihu.com",
)


def _is_latest_intent(text: str) -> bool:
    if not text:
        return False
    lower = text.lower()
    return any(token in lower for token in _LATEST_INTENT_PATTERNS)


def _is_search_tool(tool_name: str | None) -> bool:
    if not tool_name:
        return False
    lower = tool_name.lower()
    return any(token in lower for token in _SEARCH_TOOL_KEYWORDS)


def _enhance_latest_search_query(query: str, now: datetime) -> str:
    base = (query or "").strip()
    if not base:
        return base
    constraints = (
        f"仅返回{now.year}年最近30天内发布的信息，"
        f"今天是{now.strftime('%Y-%m-%d')}，"
        "优先官方公告与一手媒体，结果必须包含明确发布日期。"
    )
    return f"{base}。{constraints}"


def _extract_requested_years(text: str) -> int | None:
    if not text:
        return None
    for pattern in _TIME_SERIES_PATTERNS:
        match = _re.search(pattern, text, _re.IGNORECASE)
        if match:
            try:
                years = int(match.group(1))
                if years > 0:
                    return years
            except Exception:
                return None
    return None


def _enhance_time_series_search_query(query: str, years: int, now: datetime) -> str:
    base = (query or "").strip()
    if not base:
        return base
    start_year = max(1900, now.year - years + 1)
    constraints = (
        f"请返回按年份排列的结构化数据表，覆盖{start_year}-{now.year}，"
        "每个年份至少包含1条数值记录，优先官方统计来源（政府/国际组织）并附来源链接。"
    )
    return f"{base}。{constraints}"


def _is_finance_research_intent(text: str) -> bool:
    if not text:
        return False
    lower = text.lower()
    return any(token in lower for token in _FINANCE_RESEARCH_PATTERNS)


def _enforce_finance_research_on_plan_steps(
    steps: list[PlanStep],
    user_text: str,
    session_id: str,
) -> None:
    if not _is_finance_research_intent(user_text):
        return

    include_domains = [
        "finance.yahoo.com",
        "hk.finance.yahoo.com",
        "hkexnews.hk",
        "www.hkexnews.hk",
        "hkex.com.hk",
        "www.hkex.com.hk",
        "nasdaq.com",
        "sec.gov",
        "www.sec.gov",
        "alibabagroup.com",
        "www.alibabagroup.com",
        "ir.alibaba.com",
        "markets.ft.com",
        "reuters.com",
        "bloomberg.com",
        "wsj.com",
        "cnbc.com",
    ]
    exclude_domains = [
        "gswarrants.com.hk",
        "talkmoney.com.hk",
        "xueqiu.com",
    ]

    for step in steps:
        if not _is_search_tool(step.tool):
            continue
        query = step.params.get("query")
        if not isinstance(query, str) or not query.strip():
            continue
        step.params["query"] = (
            f"{query}。优先公司IR/交易所披露/主流财经媒体，"
            "必须返回可核对的财务指标与日期，避免衍生品权证或营销导流页面。"
            "至少返回3个不同来源域名，并包含至少1个公司/交易所官方来源。"
        )
        tool_name = (step.tool or "").lower()
        if "tavily" in tool_name:
            step.params["topic"] = "news"
            step.params["days"] = 365
            step.params["search_depth"] = "advanced"
            # Keep include_domains only as a weak fallback to avoid starving results.
            # Do not force strict allow-lists for finance, otherwise single-source
            # degeneration happens frequently (e.g. only one quote portal hit).
            if not step.params.get("include_domains"):
                step.params["include_domains"] = include_domains
            step.params["exclude_domains"] = exclude_domains
            step.params["max_results"] = max(int(step.params.get("max_results", 5) or 5), 12)
        logger.info(
            "finance_search_query_enforced",
            extra={
                "session_id": session_id,
                "step_id": step.id,
                "tool": step.tool,
                "query_preview": step.params["query"][:180],
            },
        )


def _extract_finance_focus_tokens(user_text: str) -> list[str]:
    text = user_text or ""
    lower = text.lower()
    tokens: list[str] = []

    # Capture entity in patterns like "研究拼多多股票"
    m = _re.search(r"(?:研究|分析|跟踪)\s*([^\s，。,.]{1,18}?)(?:股票|股价|财报|估值|公司)", text)
    if m:
        tokens.append(m.group(1).strip())
    m2 = _re.search(r"([^\s，。,.]{1,18}?)(?:股票|股价|财报|估值|公司)", text)
    if m2:
        tokens.append(m2.group(1).strip())

    # Common stock-code patterns
    for pat in [r"\b\d{4,5}\.HK\b", r"\b[A-Z]{1,5}\b", r"\b\d{6}\b"]:
        for mm in _re.finditer(pat, text):
            tokens.append(mm.group(0))

    # High-value alias enrichment
    if "拼多多" in text or "pdd" in lower:
        tokens.extend(["拼多多", "PDD", "PDD Holdings", "Nasdaq:PDD"])
    if "腾讯" in text or "tencent" in lower:
        tokens.extend(["腾讯", "Tencent", "0700.HK", "HKEX:700"])
    if "阿里" in text or "阿里巴巴" in text or "alibaba" in lower or "baba" in lower:
        tokens.extend([
            "阿里巴巴",
            "阿里",
            "Alibaba",
            "Alibaba Group",
            "BABA",
            "9988.HK",
            "NYSE:BABA",
            "HKEX:9988",
        ])

    # Deduplicate and drop too-short noise
    seen = set()
    out: list[str] = []
    for t in tokens:
        tt = t.strip()
        if len(tt) < 2:
            continue
        key = tt.lower()
        if key in seen:
            continue
        seen.add(key)
        out.append(tt)
    return out


def _filter_finance_search_results(
    results: list[dict[str, Any]],
    user_text: str,
) -> list[dict[str, Any]]:
    if not _is_finance_research_intent(user_text):
        return results
    if not results:
        return results

    focus_tokens = _extract_finance_focus_tokens(user_text)
    lowered_focus = [t.lower() for t in focus_tokens]

    def _is_noise_domain(url: str) -> bool:
        lower_url = (url or "").lower()
        return any(p in lower_url for p in _FINANCE_NOISE_DOMAIN_PATTERNS)

    cleaned: list[dict[str, Any]] = []
    for item in results:
        title = str(item.get("title") or "")
        url = str(item.get("url") or "")
        content = str(item.get("content") or item.get("snippet") or "")
        hay = f"{title}\n{url}\n{content}".lower()
        if _is_noise_domain(url):
            continue
        if lowered_focus:
            if not any(tok in hay for tok in lowered_focus):
                continue
        cleaned.append(item)

    # If strict focus drops everything, at least keep non-noise rows.
    if cleaned:
        return cleaned
    fallback = [
        r for r in results
        if not any(p in str(r.get("url") or "").lower() for p in _FINANCE_NOISE_DOMAIN_PATTERNS)
    ]
    return fallback


def _enforce_pdf_tool_preference(
    steps: list[PlanStep],
    user_text: str,
    available_tool_names: set[str],
    session_id: str,
) -> None:
    if "pdf" not in available_tool_names:
        return
    lower = (user_text or "").lower()
    asks_pdf = ("pdf" in lower) or ("报告" in user_text and "生成" in user_text)
    if not asks_pdf:
        return

    for step in steps:
        if step.tool != "code_executor":
            continue
        code = step.params.get("code")
        if not isinstance(code, str):
            continue
        code_lower = code.lower()
        if ".pdf" not in code_lower and "fpdf" not in code_lower and "reportlab" not in code_lower:
            continue

        filename = "report.pdf"
        match = _re.search(r"""['"]([^'"]+\.pdf)['"]""", code, _re.IGNORECASE)
        if match:
            filename = match.group(1)
        step.tool = "pdf"
        step.params = {
            "filename": filename,
            "title": "研究报告",
            "context_data": step.params.get("context_data", ""),
        }
        logger.info(
            "pdf_tool_preference_enforced",
            extra={
                "session_id": session_id,
                "step_id": step.id,
                "filename": filename,
            },
        )


def _enforce_freshness_on_plan_steps(
    steps: list[PlanStep],
    user_text: str,
    now: datetime,
    session_id: str,
) -> None:
    if not _is_latest_intent(user_text):
        return

    for step in steps:
        if not _is_search_tool(step.tool):
            continue
        query = step.params.get("query")
        if not isinstance(query, str) or not query.strip():
            continue

        step.params["query"] = _enhance_latest_search_query(query, now)
        tool_name = (step.tool or "").lower()
        if "tavily" in tool_name:
            step.params.setdefault("topic", "news")
            step.params.setdefault("days", 30)
        logger.info(
            "fresh_search_query_enforced",
            extra={
                "session_id": session_id,
                "step_id": step.id,
                "tool": step.tool,
                "query_preview": step.params["query"][:180],
            },
        )


def _enforce_time_series_on_plan_steps(
    steps: list[PlanStep],
    user_text: str,
    now: datetime,
    session_id: str,
) -> None:
    years = _extract_requested_years(user_text)
    if not years:
        return

    for step in steps:
        if not _is_search_tool(step.tool):
            continue
        query = step.params.get("query")
        if not isinstance(query, str) or not query.strip():
            continue
        step.params["query"] = _enhance_time_series_search_query(query, years, now)
        logger.info(
            "time_series_search_query_enforced",
            extra={
                "session_id": session_id,
                "step_id": step.id,
                "tool": step.tool,
                "years": years,
                "query_preview": step.params["query"][:180],
            },
        )


def _extract_search_results(tool_results: list[ToolCallResult]) -> list[dict[str, Any]]:
    """Extract structured search results from prior tool call results.

    Handles:
    - JSON dict results with "results" or "data" keys
    - Plain text tavily-style results (Title: / URL: / Content: blocks)
    - Generic text results wrapped as single items
    """
    search_results: list[dict[str, Any]] = []
    for tr in tool_results:
        if tr.tool_name == "code_executor" or not tr.success:
            continue
        result_data = tr.result
        if isinstance(result_data, str):
            try:
                result_data = json.loads(result_data)
            except (json.JSONDecodeError, TypeError):
                if "Title:" in result_data and "URL:" in result_data:
                    blocks = _re.split(r'\n\s*Title:\s*', result_data)
                    for block in blocks:
                        block = block.strip()
                        if not block:
                            continue
                        title_match = _re.match(r'^(.+?)(?:\n|$)', block)
                        url_match = _re.search(r'URL:\s*(\S+)', block)
                        content_match = _re.search(r'Content:\s*(.+)', block, _re.DOTALL)
                        if title_match:
                            search_results.append({
                                "title": title_match.group(1).strip(),
                                "url": url_match.group(1).strip() if url_match else "",
                                "content": content_match.group(1).strip()[:2000] if content_match else "",
                            })
                else:
                    search_results.append({
                        "tool": tr.tool_name,
                        "content": result_data[:3000],
                    })
                continue
        if isinstance(result_data, dict):
            items = result_data.get("results") or result_data.get("data")
            if isinstance(items, list):
                for item in items:
                    if isinstance(item, dict):
                        search_results.append(item)
                answer = result_data.get("answer")
                if isinstance(answer, str) and answer.strip():
                    search_results.append({
                        "title": "search_answer_summary",
                        "url": "",
                        "content": answer.strip()[:3000],
                    })
            else:
                search_results.append(result_data)
        elif isinstance(result_data, list):
            for item in result_data:
                if isinstance(item, dict):
                    search_results.append(item)
    # Drop placeholder/garbage rows that degrade downstream report quality.
    filtered: list[dict[str, Any]] = []
    for item in search_results:
        if not isinstance(item, dict):
            continue
        title = str(item.get("title") or "").strip()
        url = str(item.get("url") or "").strip()
        content = str(item.get("content") or item.get("snippet") or "").strip()
        if title.lower() in {"detailed results:", "detailed results"} and not url and not content:
            continue
        if not title and not url and not content:
            continue
        filtered.append(item)
    return filtered


def _inject_context_data(
    action: PlanStep,
    search_results: list[dict[str, Any]],
    session_id: str,
    user_request: str | None = None,
) -> None:
    """Inject search results as context_data into a code_executor action."""
    if action.tool not in {"code_executor", "xlsx", "pdf"} or not search_results:
        return
    filtered_results = _filter_finance_search_results(search_results, user_request or "")
    # If finance filtering becomes too strict (too few rows or too low domain
    # diversity), fall back to broad non-empty rows to avoid template-only reports.
    unique_domains = set()
    for item in filtered_results:
        try:
            from urllib.parse import urlparse as _urlparse
            host = (_urlparse(str(item.get("url") or "")).hostname or "").lower()
            if host:
                unique_domains.add(host)
        except Exception:
            continue
    if len(filtered_results) < 2 or len(unique_domains) < 2:
        is_finance = _is_finance_research_intent(user_request or "")
        finance_focus = [x.lower() for x in _extract_finance_focus_tokens(user_request or "")]
        finance_domain_hints = (
            "finance.",
            "investing.com",
            "reuters.com",
            "bloomberg.com",
            "wsj.com",
            "ft.com",
            "sec.gov",
            "hkex",
            "alibabagroup.com",
            "aastocks.com",
            "yahoo.com",
            "nasdaq.com",
        )
        finance_kw = (
            "股价",
            "股票",
            "财报",
            "估值",
            "市值",
            "目标价",
            "评级",
            "revenue",
            "earnings",
            "valuation",
            "price target",
            "eps",
            "p/e",
            "pe ratio",
        )
        broad: list[dict[str, Any]] = []
        for item in search_results:
            if not isinstance(item, dict):
                continue
            title = str(item.get("title") or "").strip()
            url = str(item.get("url") or "").strip()
            content = str(item.get("content") or item.get("snippet") or "").strip()
            if not title and not url and not content:
                continue
            if is_finance:
                hay = f"{title}\n{url}\n{content}".lower()
                domain_ok = any(h in url.lower() for h in finance_domain_hints)
                kw_ok = any(k in hay for k in finance_kw)
                focus_ok = (not finance_focus) or any(t in hay for t in finance_focus)
                if not focus_ok:
                    continue
                if not (domain_ok or kw_ok):
                    continue
            broad.append(item)
        if len(broad) >= len(filtered_results):
            filtered_results = broad
    payload = {
        "results": filtered_results,
        "user_request": user_request or "",
        "generated_at": datetime.now().isoformat(),
    }
    context_json = json.dumps(payload, ensure_ascii=False)
    existing = action.params.get("context_data", "")
    action.params["context_data"] = context_json
    logger.info(
        "Auto-injected context_data into code_executor step",
        extra={
            "session_id": session_id,
            "step_id": action.id,
            "context_data_len": len(context_json),
            "search_results_count": len(search_results),
            "filtered_results_count": len(filtered_results),
            "had_existing": bool(existing),
        },
    )


async def start_node(state: AgentState, context: dict[str, Any]) -> dict[str, Any]:
    """
    START node: Initialize execution context and load memories.

    This is the entry point for agent execution. It:
    1. Loads short-term memory (recent conversation context)
    2. Retrieves relevant long-term memories
    3. Initializes the execution context

    Args:
        state: Current agent state
        context: Injected dependencies (memory_system, etc.)

    Returns:
        State updates with memory context loaded
    """
    logger.info(
        "Starting agent execution",
        extra={"session_id": state["session_id"], "agent_id": state["agent_id"]},
    )

    event_emitter = context.get("event_emitter")
    if event_emitter:
        await event_emitter.emit_thinking("正在初始化执行上下文...", "analyzing")

    memory_system = context.get("memory_system")
    memory_context = ""

    if memory_system:
        try:
            # Load short-term memory
            short_term = await memory_system.get_short_term(state["session_id"])

            # Search long-term memory for relevant context
            user_message = state["messages"][-1]["content"] if state["messages"] else ""
            long_term = await memory_system.search_long_term(
                agent_id=state["agent_id"],
                query=user_message,
                limit=5,
                org_id=state["org_id"],
            )

            # Combine into context string
            memory_parts = []
            if short_term:
                memory_parts.append(f"Recent context:\n{short_term}")
            if long_term:
                memory_parts.append(f"Relevant knowledge:\n{long_term}")

            memory_context = "\n\n".join(memory_parts)
        except Exception as e:
            logger.warning(f"Failed to load memory: {e}")

    return {
        "memory_context": memory_context,
        "iteration": 0,
        "current_step": "plan",
    }


async def plan_node(state: AgentState, context: dict[str, Any]) -> dict[str, Any]:
    """
    PLAN node: Parse user intent and generate execution plan.

    This node uses the LLM to:
    1. Understand what the user wants to accomplish
    2. Break down the task into executable steps
    3. Determine if delegation to SubAgents is needed
    4. Generate a structured execution plan

    Args:
        state: Current agent state
        context: Injected dependencies (llm_provider, skill_registry, etc.)

    Returns:
        State updates with execution plan
    """
    logger.info(
        "Generating execution plan",
        extra={"session_id": state["session_id"], "iteration": state["iteration"]},
    )

    event_emitter = context.get("event_emitter")
    if event_emitter:
        await event_emitter.emit_thinking("正在分析任务并制定执行计划...", "planning")

    llm_provider = context.get("llm_provider")
    skill_registry = context.get("skill_registry")

    if not llm_provider:
        return {
            "error": "LLM provider not configured",
            "current_step": "respond",
        }

    # Build CapabilityGraph from RuntimeSessionContext
    available_skills = []
    runtime_context = state.get("context")

    if runtime_context:
        # Use CapabilityGraph to get available capabilities
        from src.orchestrator.capability import CapabilityGraph

        capability_graph = CapabilityGraph(runtime_context)
        available_skills = capability_graph.get_schemas_for_planner()

        logger.info(
            "Capability graph built for planning",
            extra={
                "session_id": state["session_id"],
                "capability_count": len(available_skills),
            },
        )
    elif skill_registry:
        # Fallback to skill_registry for backward compatibility
        available_skills = skill_registry.get_all_schemas()
        logger.warning(
            "Using skill_registry fallback (no RuntimeSessionContext)",
            extra={"session_id": state["session_id"]},
        )

    # Extract state data
    messages = list(state["messages"])
    memory_context = state["memory_context"]

    # On replan: inject previous tool errors so LLM can learn from failures
    tool_results = state.get("tool_results", [])
    failed_results = [r for r in tool_results if not r.success]
    if failed_results and state["iteration"] > 0:
        # Replan 时避免重复调用已经失败过的能力（尤其外部网络工具），降低“重复失败”噪声。
        failed_names = {r.tool_name for r in failed_results if r.tool_name}
        sticky_ban = {
            name for name in failed_names
            if name and name != "code_executor"
        }
        if sticky_ban:
            before = len(available_skills)
            available_skills = [
                schema
                for schema in available_skills
                if str((schema.get("function") or {}).get("name") or "") not in sticky_ban
            ]
            logger.info(
                "replan_capability_filtered",
                extra={
                    "session_id": state["session_id"],
                    "banned_tools": sorted(sticky_ban),
                    "before": before,
                    "after": len(available_skills),
                },
            )

        error_lines = []
        for r in failed_results:
            error_lines.append(f"Tool '{r.tool_name}' failed:")
            if r.error:
                error_lines.append(f"  Error: {r.error}")
            if isinstance(r.result, dict) and r.result.get("stderr"):
                error_lines.append(f"  Stderr: {r.result['stderr']}")
        error_context = "\n".join(error_lines)
        messages.append({
            "role": "user",
            "content": f"[SYSTEM] Previous execution failed. Fix the errors and generate a new plan.\n{error_context}",
        })
        logger.info(
            "Injected error context for replan",
            extra={"session_id": state["session_id"], "error_count": len(failed_results)},
        )

    try:
        # Extract agent system_prompt for LLM persona injection
        agent_system_prompt = ""
        agent_model = None
        if runtime_context and runtime_context.agent_config:
            agent_system_prompt = runtime_context.agent_config.system_prompt or ""
            agent_model = runtime_context.agent_config.model

        # Extract sub-agent candidates for planner
        sub_agents_for_planner = []
        if runtime_context and hasattr(runtime_context, 'available_sub_agents') and runtime_context.available_sub_agents:
            sub_agents_for_planner = [
                {"id": sa.id, "name": sa.name, "description": sa.description}
                for sa in runtime_context.available_sub_agents
            ]

        # Retrieve evolved skills for context injection
        evolved_skills_context = ""
        try:
            agent_config_meta = {}
            if runtime_context and hasattr(runtime_context, "agent_config") and runtime_context.agent_config:
                agent_config_meta = runtime_context.agent_config.metadata if hasattr(runtime_context.agent_config, "metadata") else {}
            evolution_config = agent_config_meta.get("evolution", {}) if isinstance(agent_config_meta, dict) else {}
            if evolution_config.get("enabled", False) and context.get("memory_system") and context.get("db_pool"):
                from src.evolution.retriever import EvolvedSkillRetriever
                from src.evolution.formatter import format_skills_for_prompt

                retriever = EvolvedSkillRetriever(
                    memory_system=context["memory_system"],
                    db_pool=context["db_pool"],
                )
                user_intent = messages[-1]["content"] if messages else ""
                relevant_skills = await retriever.search(
                    query=user_intent,
                    org_id=state["org_id"],
                    limit=5,
                )
                if relevant_skills:
                    evolved_skills_context = format_skills_for_prompt(relevant_skills)
                    logger.info(
                        f"[Evolution] 检索到 {len(relevant_skills)} 个相关进化技能",
                        extra={"session_id": state["session_id"]},
                    )
        except Exception as e:
            logger.warning(f"[Evolution] 技能检索异常（不影响规划）: {e}")

        # Inject evolved skills into memory context
        effective_memory = memory_context
        if evolved_skills_context:
            effective_memory = f"{memory_context}\n\n{evolved_skills_context}" if memory_context else evolved_skills_context

        # Call LLM to generate plan
        available_tool_names = {
            str((schema.get("function") or {}).get("name") or schema.get("name") or "")
            for schema in available_skills
        }
        plan_response = await llm_provider.generate_plan(
            messages=messages,
            memory=effective_memory,
            available_tools=available_skills,
            available_sub_agents=sub_agents_for_planner or None,
            agent_system_prompt=agent_system_prompt,
            model=agent_model,
        )

        # Emit LLM's reasoning text (non-JSON portion of the response)
        thinking_text = plan_response.pop("_thinking", "")
        if event_emitter and thinking_text:
            await event_emitter.emit_thinking(thinking_text, "planning")

        # Parse plan from response
        plan = parse_plan_response(plan_response)

        # Enforce freshness constraints for "latest/recent" user intents to
        # avoid stale search results from overly broad queries.
        user_text = messages[-1]["content"] if messages else ""
        _enforce_freshness_on_plan_steps(
            steps=plan.steps,
            user_text=user_text,
            now=datetime.now(),
            session_id=state["session_id"],
        )
        _enforce_time_series_on_plan_steps(
            steps=plan.steps,
            user_text=user_text,
            now=datetime.now(),
            session_id=state["session_id"],
        )
        _enforce_finance_research_on_plan_steps(
            steps=plan.steps,
            user_text=user_text,
            session_id=state["session_id"],
        )
        _enforce_pdf_tool_preference(
            steps=plan.steps,
            user_text=user_text,
            available_tool_names=available_tool_names,
            session_id=state["session_id"],
        )

        # Emit plan_created event
        if event_emitter and plan.steps:
            await event_emitter.emit_plan_created([
                {"id": step.id, "title": step.title}
                for step in plan.steps
            ])

        # Check if this is a simple question (no tools needed)
        if not plan.steps:
            return {
                "plan": plan,
                "pending_actions": [],
                "current_step": "respond",
            }

        return {
            "plan": plan,
            "pending_actions": plan.steps,
            "current_step": "act" if not plan.requires_delegation else "delegate",
        }

    except Exception as e:
        logger.error(f"Planning failed: {e}")
        return {
            "error": f"Planning failed: {str(e)}",
            "current_step": "respond",
        }


async def act_node(state: AgentState, context: dict[str, Any]) -> dict[str, Any]:
    """
    ACT node: Execute pending actions (tool/skill calls).

    This node:
    1. Uses UnifiedActionExecutor (with RuntimeSessionContext)
    2. Supports parallel execution for independent actions
    3. Collects results and errors

    Args:
        state: Current agent state
        context: Injected dependencies (unified_executor, event_emitter, etc.)

    Returns:
        State updates with tool execution results
    """
    logger.info(
        "Executing actions",
        extra={
            "session_id": state["session_id"],
            "action_count": len(state["pending_actions"]),
        },
    )

    event_emitter = context.get("event_emitter")

    unified_executor = context.get("unified_executor")
    if not unified_executor:
        return {
            "error": "UnifiedActionExecutor not configured",
            "current_step": "observe",
            "pending_actions": [],
        }

    pending_actions = state["pending_actions"]
    if not pending_actions:
        return {
            "current_step": "observe",
        }

    logger.info(
        "Using UnifiedActionExecutor",
        extra={"session_id": state["session_id"]},
    )

    results: list[ToolCallResult] = []

    # Separate parallel and sequential actions
    parallel_actions = [a for a in pending_actions if a.parallel]
    sequential_actions = [a for a in pending_actions if not a.parallel]

    # Force sequential if mix of search + code_executor (data dependency)
    has_search = any(
        a.tool in ["tavily-search", "tavily_search", "bailian_web_search", "exa_search"]
        for a in pending_actions
    )
    has_code = any(a.tool in {"code_executor", "xlsx", "pdf"} for a in pending_actions)
    if has_search and has_code:
        sequential_actions = pending_actions
        parallel_actions = []

    # Execute parallel actions first, then sequential actions in order
    if parallel_actions:
        import asyncio

        parallel_results = await asyncio.gather(
            *[_execute_with_events(unified_executor, action, event_emitter) for action in parallel_actions],
            return_exceptions=True,
        )
        for i, result in enumerate(parallel_results):
            if isinstance(result, Exception):
                results.append(
                    ToolCallResult(
                        tool_name=parallel_actions[i].tool or "unknown",
                        params=parallel_actions[i].params,
                        error=str(result),
                        success=False,
                    )
                )
            else:
                results.append(result)

    for action in sequential_actions:
        try:
            if action.tool in {"code_executor", "xlsx", "pdf"} and results:
                search_results = _extract_search_results(results)
                latest_user_text = ""
                for m in reversed(state.get("messages", [])):
                    if m.get("role") == "user":
                        latest_user_text = str(m.get("content") or "")
                        break
                _inject_context_data(
                    action,
                    search_results,
                    state["session_id"],
                    latest_user_text,
                )

            result = await _execute_with_events(unified_executor, action, event_emitter)
            results.append(result)
        except Exception as e:
            logger.error(f"Action execution failed: {e}")
            results.append(
                ToolCallResult(
                    tool_name=action.tool or "unknown",
                    params=action.params,
                    error=str(e),
                    success=False,
                )
            )

    # Update current_step_index to last step so observe_node knows all steps are done
    plan = state.get("plan")
    updated_plan = None
    if plan and plan.steps:
        updated_plan = ExecutionPlan(
            goal=plan.goal,
            steps=plan.steps,
            current_step_index=len(plan.steps) - 1,
            requires_delegation=plan.requires_delegation,
            delegate_to=plan.delegate_to,
        )

    result_state = {
        "tool_results": results,
        "pending_actions": [],
        "current_step": "observe",
    }
    if updated_plan:
        result_state["plan"] = updated_plan
    return result_state


async def _execute_with_events(
    executor: Any,
    action: PlanStep,
    event_emitter: Any | None,
) -> ToolCallResult:
    """Execute a single action and emit events before/after."""
    start_ms = time.monotonic()

    # Pre-execution events
    if event_emitter:
        await event_emitter.emit_plan_step_start(action.id, action.title, action.tool, action.params)
        if action.tool:
            await event_emitter.emit_tool_call_start(action.tool, action.params)

    result: ToolCallResult = await executor.execute(action)
    duration_ms = int((time.monotonic() - start_ms) * 1000)

    # Post-execution events
    if event_emitter:
        if result.success:
            await event_emitter.emit_tool_call_complete(
                result.tool_name, result.result, True, duration=duration_ms,
            )
            await event_emitter.emit_plan_step_complete(
                action.id, action.title, result.result, duration_ms,
            )
        else:
            await event_emitter.emit_tool_call_complete(
                result.tool_name, result.result, False, error=result.error, duration=duration_ms,
            )
            await event_emitter.emit_plan_step_failed(action.id, action.title, result.error or "Unknown error")

        # Emit file_created events for any generated files
        generated_files = (result.metadata or {}).get("generated_files", [])
        logger.info(
            "[ACT] file_created check",
            extra={
                "tool_name": result.tool_name,
                "has_metadata": result.metadata is not None,
                "metadata_keys": list((result.metadata or {}).keys()),
                "generated_files_count": len(generated_files),
            },
        )
        for file_meta in generated_files:
            file_id = file_meta.get("file_id", "")
            await event_emitter.emit_file_created(
                file_id=file_id,
                filename=file_meta.get("filename", ""),
                mime_type=file_meta.get("mime_type", "application/octet-stream"),
                size=file_meta.get("size", 0),
                url=f"/api/v1/files/{file_id}",
            )

    return result


async def delegate_node(state: AgentState, context: dict[str, Any]) -> dict[str, Any]:
    """
    DELEGATE node: Delegate task to a SubAgent.

    This node:
    1. Identifies the appropriate SubAgent
    2. Prepares the delegation context
    3. Executes the SubAgent
    4. Collects the SubAgent's results

    Args:
        state: Current agent state
        context: Injected dependencies (sub_agent_delegator, etc.)

    Returns:
        State updates with SubAgent results
    """
    logger.info(
        "Delegating to SubAgent",
        extra={
            "session_id": state["session_id"],
            "delegate_to": state["plan"].delegate_to if state["plan"] else None,
        },
    )

    event_emitter = context.get("event_emitter")
    delegator = context.get("sub_agent_delegator")
    plan = state["plan"]

    if not delegator or not plan or not plan.delegate_to:
        return {
            "error": "Delegation not configured or no target specified",
            "current_step": "observe",
        }

    try:
        # Emit skill call start
        if event_emitter:
            await event_emitter.emit_skill_call_start(
                plan.delegate_to, f"subagent:{plan.delegate_to}", {"task": plan.goal},
            )

        # Get the task from plan
        task = plan.goal
        delegation_context = {
            "memory": state["memory_context"],
            "parent_session_id": state["session_id"],
        }

        result = await delegator.delegate(
            sub_agent_id=plan.delegate_to,
            task=task,
            context=delegation_context,
        )

        # Convert SubAgent result to ToolCallResult format
        tool_result = ToolCallResult(
            tool_name=f"subagent:{plan.delegate_to}",
            params={"task": task},
            result=result.get("result"),
            success=not result.get("error"),
            error=result.get("error"),
        )

        # Emit skill call complete
        if event_emitter:
            await event_emitter.emit_skill_call_complete(
                plan.delegate_to,
                f"subagent:{plan.delegate_to}",
                result.get("result"),
                not result.get("error"),
                error=result.get("error"),
            )

        return {
            "tool_results": [tool_result],
            "current_step": "observe",
        }

    except Exception as e:
        logger.error(f"Delegation failed: {e}")

        if event_emitter:
            await event_emitter.emit_skill_call_complete(
                plan.delegate_to,
                f"subagent:{plan.delegate_to}",
                None,
                False,
                error=str(e),
            )

        return {
            "tool_results": [
                ToolCallResult(
                    tool_name=f"subagent:{plan.delegate_to}",
                    params={},
                    error=str(e),
                    success=False,
                )
            ],
            "current_step": "observe",
        }


async def observe_node(state: AgentState, context: dict[str, Any]) -> dict[str, Any]:
    """
    OBSERVE node: Evaluate results and decide next step.

    This node:
    1. Analyzes tool/skill execution results
    2. Checks for errors or failures
    3. Determines if replanning is needed
    4. Decides whether to continue, replan, or complete

    Args:
        state: Current agent state
        context: Injected dependencies (llm_provider, etc.)

    Returns:
        State updates with next step decision
    """
    logger.info(
        "Observing results",
        extra={
            "session_id": state["session_id"],
            "result_count": len(state["tool_results"]),
        },
    )

    event_emitter = context.get("event_emitter")
    if event_emitter:
        await event_emitter.emit_thinking("正在分析执行结果...", "reasoning")

    llm_provider = context.get("llm_provider")
    config = context.get("config", {})
    max_iterations = config.get("max_iterations", 10)

    # Check iteration limit
    current_iteration = state["iteration"] + 1
    if current_iteration >= max_iterations:
        logger.warning(
            f"Max iterations reached: {max_iterations}",
            extra={"session_id": state["session_id"]},
        )
        return {
            "iteration": current_iteration,
            "current_step": "reflect",
        }

    # Analyze results
    tool_results = state["tool_results"]
    has_errors = any(not r.success for r in tool_results)
    all_failed = all(not r.success for r in tool_results) if tool_results else False

    # If all failed, try replanning
    if all_failed and current_iteration < MAX_REPLAN_ATTEMPTS:
        logger.info(
            "replan_attempt",
            current_iteration=current_iteration,
            max_attempts=MAX_REPLAN_ATTEMPTS,
        )
        return {
            "iteration": current_iteration,
            "current_step": "plan",
        }

    # Check if there are more pending steps in the plan
    plan = state["plan"]
    if plan and plan.steps and plan.current_step_index < len(plan.steps) - 1:
        successful_results = [r for r in tool_results if r.success and r.result]
        remaining_steps = plan.steps[plan.current_step_index + 1:]

        # If we have successful results and remaining steps, ask LLM whether
        # the next step can proceed as-is or needs replanning with actual data.
        if (
            successful_results
            and remaining_steps
            and llm_provider
            and current_iteration < MAX_REPLAN_ATTEMPTS
        ):
            decision = await _llm_observe_decision(
                llm_provider=llm_provider,
                plan=plan,
                completed_results=successful_results,
                remaining_steps=remaining_steps,
                session_id=state["session_id"],
            )

            if decision["action"] == "replan":
                logger.info(
                    "LLM observe decision: replan",
                    extra={
                        "session_id": state["session_id"],
                        "reason": decision.get("reason", ""),
                    },
                )
                if event_emitter:
                    await event_emitter.emit_thinking(
                        decision.get("reason", "需要基于已有结果重新规划后续步骤..."),
                        "planning",
                    )

                # Build replan context message with completed results
                results_summary = []
                for r in successful_results:
                    result_str = r.result if isinstance(r.result, str) else str(r.result)
                    if len(result_str) > REPLAN_RESULT_MAX_CHARS:
                        result_str = result_str[:REPLAN_RESULT_MAX_CHARS] + "...(truncated)"
                    results_summary.append(f"[{r.tool_name}] result:\n{result_str}")

                completed_titles = [
                    f"- {s.title} (tool: {s.tool})"
                    for s in plan.steps[: plan.current_step_index + 1]
                ]
                remaining_titles = [
                    f"- {s.title} (tool: {s.tool})" for s in remaining_steps
                ]

                context_msg = Message(
                    role="user",
                    content=(
                        f"[SYSTEM] REPLAN — the observer decided that remaining steps "
                        f"need to be re-generated based on actual execution results.\n\n"
                        f"Reason: {decision.get('reason', 'N/A')}\n\n"
                        f"COMPLETED STEPS and their results:\n"
                        + "\n".join(completed_titles)
                        + "\n\n"
                        + "\n\n".join(results_summary)
                        + f"\n\nORIGINAL REMAINING STEPS:\n"
                        + "\n".join(remaining_titles)
                        + f"\n\nINSTRUCTIONS:\n"
                        f"- Generate a new plan for the remaining work.\n"
                        f"- You have access to the actual results above. Use them.\n"
                        f"- CRITICAL — DATA PASSING via context_data:\n"
                        f"  When a code_executor step needs data from previous steps (e.g. search results),\n"
                        f"  you MUST pass that data using the 'context_data' parameter (a JSON string).\n"
                        f"  The data will be written to 'context.json' in the working directory.\n"
                        f"  The code should read it with:\n"
                        f"    import json\n"
                        f"    data = json.load(open('context.json', encoding='utf-8'))\n"
                        f"  Then use the data to build the report content.\n"
                        f"  DO NOT embed large data as string literals in the code — use context_data instead.\n"
                        f"- Structure the context_data as a JSON object with the search results, e.g.:\n"
                        f'  {{"results": [{{"title": "...", "url": "...", "content": "..."}},...]}}\n'
                        f"- For PDF/XLSX generation: the code MUST read from context.json and produce\n"
                        f"  DETAILED, COMPREHENSIVE content with real titles, descriptions, dates, analysis,\n"
                        f"  and source URLs from the search results.\n"
                        f"- You may decide to re-run a completed tool if you judge the result "
                        f"was insufficient, but avoid unnecessary repetition.\n"
                        f"- Overall goal: {plan.goal}"
                    ),
                    name=None,
                    tool_call_id=None,
                )
                return {
                    "iteration": current_iteration,
                    "messages": [context_msg],
                    "current_step": "plan",
                }

            elif decision["action"] == "done":
                logger.info(
                    "LLM observe decision: done (skip remaining steps)",
                    extra={
                        "session_id": state["session_id"],
                        "reason": decision.get("reason", ""),
                    },
                )
                return {
                    "iteration": current_iteration,
                    "current_step": "reflect",
                }

            # decision["action"] == "continue" — fall through to normal path

        # Normal path: proceed to next step
        next_actions = plan.steps[plan.current_step_index + 1 :]
        updated_plan = ExecutionPlan(
            goal=plan.goal,
            steps=plan.steps,
            current_step_index=plan.current_step_index + 1,
            requires_delegation=plan.requires_delegation,
            delegate_to=plan.delegate_to,
        )
        return {
            "iteration": current_iteration,
            "plan": updated_plan,
            "pending_actions": next_actions[:1],  # Execute one step at a time
            "current_step": "act",
        }

    # All steps completed, move to reflection
    return {
        "iteration": current_iteration,
        "current_step": "reflect",
    }


async def _llm_observe_decision(
    llm_provider: Any,
    plan: ExecutionPlan,
    completed_results: list[ToolCallResult],
    remaining_steps: list[PlanStep],
    session_id: str,
) -> dict[str, str]:
    """Ask LLM to decide whether remaining steps can proceed as-is or need replanning.

    Returns:
        {"action": "continue"|"replan"|"done", "reason": "..."}
    """
    import json as _json

    # Build a concise summary of what happened and what's next
    completed_summary = []
    for r in completed_results:
        result_preview = r.result if isinstance(r.result, str) else str(r.result)
        if len(result_preview) > 500:
            result_preview = result_preview[:500] + "..."
        completed_summary.append(
            f"- Tool: {r.tool_name}, Success: {r.success}, Result preview: {result_preview}"
        )

    remaining_summary = []
    for s in remaining_steps:
        params_preview = str(s.params)
        if len(params_preview) > 300:
            params_preview = params_preview[:300] + "..."
        remaining_summary.append(
            f"- Step: {s.title}, Tool: {s.tool}, Params preview: {params_preview}"
        )

    prompt = (
        "You are an execution observer in an AI agent system. "
        "A multi-step plan is being executed. Some steps have completed and produced results. "
        "You need to decide what to do with the remaining steps.\n\n"
        f"Overall goal: {plan.goal}\n\n"
        f"COMPLETED steps and results:\n"
        + "\n".join(completed_summary)
        + f"\n\nREMAINING steps (not yet executed):\n"
        + "\n".join(remaining_summary)
        + "\n\nDecide ONE of the following:\n"
        '1. "continue" — The remaining steps can proceed as planned. '
        "Their parameters/code do NOT depend on the actual data from completed steps, "
        "or they are already correctly configured.\n"
        '2. "replan" — The remaining steps need to be re-generated because '
        "their parameters or code reference data that should come from the completed steps' "
        "actual results (e.g., code that generates a report should use real search data, "
        "not placeholder content).\n"
        '3. "done" — The completed results already fulfill the overall goal. '
        "The remaining steps are unnecessary.\n\n"
        "Respond in JSON: {\"action\": \"continue|replan|done\", \"reason\": \"brief explanation\"}"
    )

    try:
        response = await llm_provider.chat(
            messages=[{"role": "user", "content": prompt}],
            temperature=0,
            response_format={"type": "json_object"},
        )
        result = _json.loads(response.content)
        action = result.get("action", "continue")
        if action not in ("continue", "replan", "done"):
            action = "continue"
        return {"action": action, "reason": result.get("reason", "")}
    except Exception as e:
        logger.warning(
            f"LLM observe decision failed, defaulting to continue: {e}",
            extra={"session_id": session_id},
        )
        return {"action": "continue", "reason": f"LLM decision failed: {e}"}


async def _update_evolved_skill_reuse_counts(state: AgentState, context: dict[str, Any]) -> None:
    """Update use/success counts for evolved skills referenced in this execution."""
    evolved_skill_refs = state.get("evolved_skill_refs", [])
    if not evolved_skill_refs:
        return

    db_pool = context.get("db_pool")
    if not db_pool:
        return

    tool_results = state.get("tool_results", [])
    has_success = any(r.success for r in tool_results) if tool_results else False

    for skill_ref in evolved_skill_refs:
        skill_id = skill_ref.get("id")
        if not skill_id:
            continue
        try:
            if has_success:
                await db_pool.execute(
                    "UPDATE evolved_skills SET success_count = success_count + 1, updated_at = NOW() WHERE id = $1",
                    skill_id,
                )
                logger.info(f"[Evolution] 进化技能复用成功 (id={skill_id})")
        except Exception as e:
            logger.warning(f"[Evolution] 更新成功计数失败: {e}")


async def reflect_node(state: AgentState, context: dict[str, Any]) -> dict[str, Any]:
    """
    REFLECT node: Summarize execution and extract learnings.

    This node:
    1. Summarizes what was accomplished
    2. Extracts key lessons learned
    3. Determines if insights should be stored in long-term memory
    4. Stores valuable learnings

    Args:
        state: Current agent state
        context: Injected dependencies (llm_provider, memory_system, etc.)

    Returns:
        State updates with reflection summary
    """
    logger.info(
        "Reflecting on execution",
        extra={"session_id": state["session_id"]},
    )

    event_emitter = context.get("event_emitter")
    if event_emitter:
        await event_emitter.emit_thinking("正在总结执行结果...", "concluding")

    llm_provider = context.get("llm_provider")
    memory_system = context.get("memory_system")

    # Generate reflection
    reflection = ReflectionResult(
        summary="Task completed.",
        lessons_learned=[],
        worth_remembering=False,
        importance=0.5,
    )

    if llm_provider:
        try:
            # Extract agent system_prompt for LLM persona injection
            agent_system_prompt = ""
            agent_model = None
            runtime_context = state.get("context")
            if runtime_context and runtime_context.agent_config:
                agent_system_prompt = runtime_context.agent_config.system_prompt or ""
                agent_model = runtime_context.agent_config.model

            reflection_response = await llm_provider.reflect(
                messages=state["messages"],
                plan=state["plan"],
                results=state["tool_results"],
                agent_system_prompt=agent_system_prompt,
                model=agent_model,
            )
            reflection = parse_reflection_response(reflection_response)
        except Exception as e:
            logger.warning(f"Reflection generation failed: {e}")

    # Store valuable learnings in long-term memory
    if reflection.worth_remembering and memory_system:
        try:
            await memory_system.save_long_term(
                agent_id=state["agent_id"],
                content=reflection.summary,
                importance=reflection.importance,
                org_id=state["org_id"],
            )
        except Exception as e:
            logger.warning(f"Failed to save to long-term memory: {e}")

    # Async evolution trigger (fire-and-forget, never blocks main flow)
    evolution_triggered = False
    try:
        from src.evolution.engine import EvolutionEngine

        evolution_engine_deps = {
            "llm": context.get("llm_provider"),
            "memory": context.get("memory_system"),
            "registry": context.get("skill_registry"),
            "db": context.get("db_pool"),
        }
        if all(evolution_engine_deps.values()):
            evolution_engine = EvolutionEngine(
                llm=evolution_engine_deps["llm"],
                memory_system=evolution_engine_deps["memory"],
                skill_registry=evolution_engine_deps["registry"],
                db_pool=evolution_engine_deps["db"],
            )
            # Build evolution-compatible state
            runtime_ctx = state.get("context")
            agent_config = {}
            if runtime_ctx and hasattr(runtime_ctx, "agent_config") and runtime_ctx.agent_config:
                agent_config = runtime_ctx.agent_config.metadata if hasattr(runtime_ctx.agent_config, "metadata") else {}
            evolution_state = {
                "reflection": {"success": reflection.worth_remembering, "summary": reflection.summary},
                "tool_results": state.get("tool_results", []),
                "agent_config": agent_config,
                "agent_id": state["agent_id"],
                "org_id": state["org_id"],
                "session_id": state["session_id"],
                "messages": state.get("messages", []),
                "plan": state.get("plan"),
            }
            await evolution_engine.maybe_evolve(evolution_state)
            evolution_triggered = True
    except Exception as e:
        logger.warning(f"[Evolution] 触发进化异常（不影响主流程）: {e}")

    return {
        "reflection": reflection,
        "current_step": "respond",
        "evolution_triggered": evolution_triggered,
    }


async def respond_node(state: AgentState, context: dict[str, Any]) -> dict[str, Any]:
    """
    RESPOND node: Generate final response to user.

    This node:
    1. Synthesizes all results and reflections
    2. Generates a user-friendly response
    3. Adds the response to message history

    Args:
        state: Current agent state
        context: Injected dependencies (llm_provider, etc.)

    Returns:
        State updates with final response message
    """
    logger.info(
        "Generating response",
        extra={"session_id": state["session_id"]},
    )

    event_emitter = context.get("event_emitter")
    llm_provider = context.get("llm_provider")

    # Check for errors
    if state["error"]:
        error_message = Message(
            role="assistant",
            content=f"I encountered an error: {state['error']}. Please try again.",
            name=None,
            tool_call_id=None,
        )
        if event_emitter:
            await event_emitter.emit_text_chunk(error_message["content"])
        return {"messages": [error_message]}

    # Generate response
    response_content = "Task completed."

    if llm_provider:
        try:
            # Extract agent system_prompt for LLM persona injection
            agent_system_prompt = ""
            agent_model = None
            runtime_context = state.get("context")
            if runtime_context and runtime_context.agent_config:
                agent_system_prompt = runtime_context.agent_config.system_prompt or ""
                agent_model = runtime_context.agent_config.model

            # Pass memory_context so LLM can maintain multi-turn context
            memory_ctx = state.get("memory_context", "")

            # Use streaming to emit text chunks incrementally
            if event_emitter and hasattr(llm_provider, 'generate_response_stream'):
                chunks = []
                async for chunk in llm_provider.generate_response_stream(
                    messages=state["messages"],
                    results=state["tool_results"],
                    reflection=state.get("reflection"),
                    agent_system_prompt=agent_system_prompt,
                    model=agent_model,
                    memory_context=memory_ctx,
                ):
                    chunks.append(chunk)
                    await event_emitter.emit_text_chunk(chunk)
                response_content = "".join(chunks)
            else:
                response_content = await llm_provider.generate_response(
                    messages=state["messages"],
                    results=state["tool_results"],
                    reflection=state.get("reflection"),
                    agent_system_prompt=agent_system_prompt,
                    model=agent_model,
                    memory_context=memory_ctx,
                )
                if event_emitter:
                    await event_emitter.emit_text_chunk(response_content)
        except Exception as e:
            logger.error(f"Response generation failed: {e}")
            response_content = f"I completed the task but encountered an issue generating the response: {e}"
            if event_emitter:
                await event_emitter.emit_text_chunk(response_content)

    elif event_emitter:
        await event_emitter.emit_text_chunk(response_content)

    response_message = Message(
        role="assistant",
        content=response_content,
        name=None,
        tool_call_id=None,
    )

    # Save conversation turn to short-term memory for future context
    memory_system = context.get("memory_system")
    if memory_system:
        try:
            # Save user message
            user_message = state["messages"][-1]["content"] if state["messages"] else ""
            if user_message:
                await memory_system.save_short_term(
                    session_id=state["session_id"],
                    content=f"[user] {user_message}",
                    agent_id=state["agent_id"],
                )
            # Save assistant response
            if response_content:
                await memory_system.save_short_term(
                    session_id=state["session_id"],
                    content=f"[assistant] {response_content}",
                    agent_id=state["agent_id"],
                )
        except Exception as e:
            logger.warning(f"Failed to save short-term memory: {e}")

    return {"messages": [response_message]}


# Helper functions
