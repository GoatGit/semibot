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
import os
import shlex
import time
from contextlib import suppress
from datetime import datetime
from itertools import product
from pathlib import Path
from typing import Any

from src.constants import MAX_REPLAN_ATTEMPTS, REPLAN_RESULT_MAX_CHARS
from src.orchestrator.execution import (
    parse_plan_response,
    parse_reflection_response,
)
from src.skills.execution_guard import ExecutionAdvisor
from src.skills.skill_index_prompt import build_skill_index_entries, format_skills_for_prompt
from src.skills.skill_injection_tracker import SkillInjectionTracker
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

_BROWSER_INTENT_KEYWORDS = (
    "访问",
    "打开",
    "网页",
    "网站",
    "浏览器",
    "登录",
    "login",
    "click",
    "点击",
    "form",
    "表单",
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

_RECOVERABLE_REPLAN_ERROR_MARKERS = (
    "RULE_NAME_CONFLICT",
    "INVALID_NOTIFY_TARGET",
    "INVALID_ACTION_MODE",
    "INVALID_CRON_SCHEDULE",
    "Tool or skill",
    "not in capability graph",
)


def _format_planning_error(exc: Exception) -> str:
    """Unwrap retry wrappers so planner errors expose the root provider message."""
    root: Exception | None = exc
    visited: set[int] = set()

    while root is not None and id(root) not in visited:
        visited.add(id(root))

        # Tenacity RetryError carries the real exception in last_attempt.exception().
        if root.__class__.__name__ == "RetryError":
            last_attempt = getattr(root, "last_attempt", None)
            if last_attempt is not None and hasattr(last_attempt, "exception"):
                with suppress(Exception):
                    inner = last_attempt.exception()
                    if isinstance(inner, Exception):
                        root = inner
                        continue

        if isinstance(getattr(root, "__cause__", None), Exception):
            root = root.__cause__
            continue
        if isinstance(getattr(root, "__context__", None), Exception):
            root = root.__context__
            continue
        break

    if root is None:
        return str(exc)
    if root is exc:
        return str(exc)

    outer = str(exc).strip()
    inner = str(root).strip()
    inner_name = root.__class__.__name__
    if outer and inner and inner not in outer:
        return f"{outer}; root={inner_name}: {inner}"
    if inner:
        return f"{inner_name}: {inner}"
    return inner_name

_PREMATURE_RESPONSE_PATTERNS = (
    "我将",
    "我会",
    "稍等",
    "请稍等",
    "正在为您",
    "马上为您",
    "i will",
    "i'll",
    "let me",
    "give you detailed",
)

_RULE_AUTHORING_INTENT_KEYWORDS = (
    "规则",
    "cron",
    "定时",
    "提醒",
    "schedule",
    "scheduled",
    "每分钟",
    "每小时",
    "每天",
    "every minute",
    "every hour",
    "every day",
    "rule",
    "create_rule",
    "update_rule",
)

_SKILL_TOKEN_I18N_ALIASES: dict[str, tuple[str, ...]] = {
    # Common capability words for cross-language skill mention matching.
    "deep": ("深度", "深入"),
    "research": ("研究", "调研"),
    "stock": ("股票",),
    "market": ("市场",),
    "analysis": ("分析",),
    "report": ("报告",),
    "search": ("搜索", "检索"),
    "browser": ("浏览器",),
    "automation": ("自动化",),
    "file": ("文件",),
    "skill": ("技能",),
    "installer": ("安装", "安装器"),
    "creator": ("创建",),
    "agent": ("智能体", "助手"),
}

_PLANNER_SKILL_MD_MAX_CHARS = 6000
_PLANNER_MEMORY_MAX_CHARS = 6000
_PLANNER_MEMORY_MAX_ASSISTANT_TURN_CHARS = 1200
_MAX_SKILLS_IN_PROMPT = int(os.getenv("SEMIBOT_MAX_SKILLS_IN_PROMPT", "50"))
_MAX_SKILLS_PROMPT_CHARS = int(os.getenv("SEMIBOT_MAX_SKILLS_PROMPT_CHARS", "8000"))
_MAX_SKILL_DESC_CHARS = int(os.getenv("SEMIBOT_MAX_SKILL_DESC_CHARS", "200"))
_SCRIPT_CLI_ADVISOR = ExecutionAdvisor()
_SKILL_CONTEXT_TOOL_NAME_PREFIX = "tools/skill_context"
_SKILL_CONTEXT_TOOL_CALL_ID_PREFIX = "skill_ctx_"
_REPORT_SYNTHESIS_KEYWORDS = (
    "整合",
    "综合",
    "总结",
    "汇总",
    "分析结论",
    "生成报告",
    "撰写报告",
    "研究报告",
    "预测报告",
    "report",
    "synthesis",
    "summarize",
)
_REPORT_RETRIEVAL_KEYWORDS = (
    "查找",
    "搜索",
    "搜集",
    "检索",
    "find",
    "search",
    "lookup",
)


def _delegation_available(runtime_context: Any, plan: ExecutionPlan | None) -> bool:
    """Check whether current plan can delegate in this runtime context."""
    if not plan or not plan.requires_delegation or not plan.delegate_to:
        return False
    if not runtime_context:
        return False

    policy = getattr(runtime_context, "runtime_policy", None)
    if policy is not None and getattr(policy, "enable_delegation", True) is False:
        return False

    sub_agents = getattr(runtime_context, "available_sub_agents", None) or []
    if not sub_agents:
        return False

    delegate_to = str(plan.delegate_to)
    return any(getattr(sa, "id", None) == delegate_to for sa in sub_agents)


def _is_rule_authoring_intent(text: str) -> bool:
    if not text:
        return False
    lower = text.lower()
    if any(keyword in lower for keyword in _RULE_AUTHORING_INTENT_KEYWORDS):
        return True
    # Relative reminder patterns.
    if _re.search(r"\b\d{1,3}\s*minutes?\s*(later|after)\b", lower):
        return True
    if _re.search(r"\d{1,3}\s*分钟\s*后", text):
        return True
    return False


def _filter_rule_authoring_by_intent(available_schemas: list[dict[str, Any]], user_text: str) -> list[dict[str, Any]]:
    if _is_rule_authoring_intent(user_text):
        return available_schemas
    filtered: list[dict[str, Any]] = []
    for schema in available_schemas:
        function_name = str((schema.get("function") or {}).get("name") or "")
        if function_name in {"rule_authoring", "control_plane"}:
            continue
        filtered.append(schema)
    return filtered


def _merge_dynamic_registry_schemas(
    available_schemas: list[dict[str, Any]],
    runtime_context: Any,
) -> list[dict[str, Any]]:
    """Merge latest tool schemas from runtime skill registry (if present)."""
    if not runtime_context:
        return available_schemas
    metadata = getattr(runtime_context, "metadata", None)
    if not isinstance(metadata, dict):
        return available_schemas
    registry = metadata.get("skill_registry")
    if registry is None or not hasattr(registry, "get_tool_schemas"):
        return available_schemas
    try:
        fresh = registry.get_tool_schemas()
    except Exception:
        return available_schemas

    blocked_skill_names: set[str] = set()
    available_skills = getattr(runtime_context, "available_skills", None)
    if isinstance(available_skills, list):
        blocked_skill_names = {
            str(getattr(skill, "name", "")).strip()
            for skill in available_skills
            if str(getattr(skill, "name", "")).strip()
        }

    allowed_names: set[str] = set()
    get_capability_names = getattr(runtime_context, "get_all_capability_names", None)
    if callable(get_capability_names):
        try:
            allowed_names = {str(name).strip() for name in get_capability_names() if str(name).strip()}
        except Exception:
            allowed_names = set()

    merged = list(available_schemas)
    existing = {
        str((item.get("function") or {}).get("name") or "")
        for item in merged
        if isinstance(item, dict)
    }
    for schema in fresh:
        if not isinstance(schema, dict):
            continue
        name = str((schema.get("function") or {}).get("name") or "")
        if allowed_names and name not in allowed_names:
            continue
        if name in blocked_skill_names:
            continue
        if not name or name in existing:
            continue
        merged.append(schema)
        existing.add(name)
    return merged


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


def _is_browser_intent(text: str) -> bool:
    if not text:
        return False
    lower = text.lower()
    return any(token in lower for token in _BROWSER_INTENT_KEYWORDS)


def _extract_target_url(text: str) -> str | None:
    if not text:
        return None

    explicit = _re.search(r"https?://[^\s，。,\"'）)]+", text, _re.IGNORECASE)
    if explicit:
        return explicit.group(0).rstrip(".,)")

    domain = _re.search(
        r"\b(?:www\.)?[a-zA-Z0-9-]+\.[a-zA-Z]{2,}(?:/[^\s，。,\"'）)]*)?",
        text,
    )
    if not domain:
        return None
    value = domain.group(0).rstrip(".,)")
    return value if value.lower().startswith("http") else f"https://{value}"


def _enforce_browser_tool_preference(
    steps: list[PlanStep],
    user_text: str,
    available_tool_names: set[str],
    session_id: str,
) -> None:
    if "browser_automation" not in available_tool_names:
        return
    if not _is_browser_intent(user_text):
        return
    if any((step.tool or "").strip() == "browser_automation" for step in steps):
        return

    target_url = _extract_target_url(user_text)
    if not target_url:
        return

    steps.insert(
        0,
        PlanStep(
            id="browser_open_1",
            title="打开目标网页",
            tool="browser_automation",
            params={"action": "open", "url": target_url},
            parallel=False,
        ),
    )
    logger.info(
        "browser_tool_preference_enforced",
        extra={"session_id": session_id, "url": target_url},
    )


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


def _tool_result_error_text(result: ToolCallResult | dict[str, Any]) -> str:
    """Extract a normalized error text from a tool result object/dict."""
    if isinstance(result, dict):
        parts = [str(result.get("error") or "")]
        result_payload = result.get("result")
        if isinstance(result_payload, dict):
            parts.append(str(result_payload.get("error") or ""))
            parts.append(str(result_payload.get("code") or ""))
            parts.append(str(result_payload.get("error_code") or ""))
        return " ".join(p for p in parts if p).strip()

    parts = [str(getattr(result, "error", "") or "")]
    result_payload = getattr(result, "result", None)
    if isinstance(result_payload, dict):
        parts.append(str(result_payload.get("error") or ""))
        parts.append(str(result_payload.get("code") or ""))
        parts.append(str(result_payload.get("error_code") or ""))
    return " ".join(p for p in parts if p).strip()


def _has_recoverable_replan_error(tool_results: list[ToolCallResult | dict[str, Any]]) -> bool:
    """Return True if failed tool results contain deterministic recoverable errors."""
    for result in tool_results:
        success = bool(result.get("success")) if isinstance(result, dict) else bool(result.success)
        if success:
            continue
        error_text = _tool_result_error_text(result)
        if any(marker in error_text for marker in _RECOVERABLE_REPLAN_ERROR_MARKERS):
            return True
    return False


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


def _looks_like_premature_final_response(text: str) -> bool:
    content = (text or "").strip()
    if not content:
        return True
    lower = content.lower()
    has_promise_phrase = any(token in content for token in _PREMATURE_RESPONSE_PATTERNS) or any(
        token in lower for token in _PREMATURE_RESPONSE_PATTERNS
    )
    if not has_promise_phrase:
        return False
    has_evidence = (
        "http" in lower
        or "参考来源" in content
        or "risk" in lower
        or "风险提示" in content
        or bool(_re.search(r"\d{2,}", content))
    )
    # Promise-like short answers without concrete evidence are treated as premature.
    return len(content) < 220 and not has_evidence


def _build_tool_result_fallback_response(
    tool_results: list[ToolCallResult],
    messages: list[Message | dict[str, Any]],
) -> str:
    query = ""
    for message in reversed(messages):
        role = str(message.get("role") if isinstance(message, dict) else getattr(message, "role", ""))
        if role != "user":
            continue
        content = str(message.get("content") if isinstance(message, dict) else getattr(message, "content", ""))
        if content and not content.startswith("[SYSTEM]"):
            query = content
            break

    successful = [row for row in tool_results if row.success]
    search_rows = _extract_search_results(successful)
    title = query.strip() or "当前请求"
    lines: list[str] = [f"已完成对“{title}”的检索与整理。"]

    if search_rows:
        lines.append("关键线索（来自已执行工具结果）：")
        for idx, item in enumerate(search_rows[:6], start=1):
            row_title = str(item.get("title") or item.get("name") or f"来源 {idx}").strip()
            row_url = str(item.get("url") or "").strip()
            row_snippet = str(item.get("snippet") or item.get("content") or "").strip().replace("\n", " ")
            if len(row_snippet) > 120:
                row_snippet = row_snippet[:120] + "..."
            if row_url:
                lines.append(f"{idx}. {row_title}（{row_url}）")
            else:
                lines.append(f"{idx}. {row_title}")
            if row_snippet:
                lines.append(f"要点：{row_snippet}")
        lines.append("风险提示：以上结论仅基于当前检索结果，投资决策前请以公司公告与交易所披露为准。")
        return "\n".join(lines)

    lines.append("当前执行结果中缺少可提炼的结构化内容。请重试并补充更具体的研究维度（如财务、估值、竞争格局）。")
    return "\n".join(lines)


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


def _extract_generated_file_candidates(results: list[ToolCallResult]) -> list[str]:
    candidates: list[str] = []
    path_pattern = _re.compile(r"(/[^\\\s'\"]+\.(?:md|markdown|html|pdf|json|txt))", flags=_re.IGNORECASE)
    for result in results:
        if not getattr(result, "success", False):
            continue
        payload = getattr(result, "result", None)
        if not isinstance(payload, dict):
            continue
        for key in ("stdout", "stderr"):
            text = str(payload.get(key) or "")
            for match in path_pattern.findall(text):
                normalized = str(match).strip()
                if not normalized:
                    continue
                try:
                    candidate_path = Path(normalized).expanduser()
                    if not candidate_path.exists() or not candidate_path.is_file():
                        continue
                except Exception:
                    continue
                if normalized not in candidates:
                    candidates.append(normalized)
    return candidates


def _pick_generated_file(candidates: list[str], expected_suffixes: tuple[str, ...]) -> str | None:
    lowered = tuple(item.lower() for item in expected_suffixes)
    for candidate in reversed(candidates):
        if candidate.lower().endswith(lowered):
            return candidate
    return None


def _pick_followup_skill_candidate(
    runtime_context: Any | None,
    user_text: str,
    current_skill_name: str,
) -> dict[str, Any] | None:
    if not runtime_context or not user_text:
        return None
    current_normalized = str(current_skill_name or "").strip().lower()
    text = str(user_text or "").strip().lower()
    best: dict[str, Any] | None = None
    best_score = 0
    for skill in getattr(runtime_context, "available_skills", []) or []:
        skill_name = str(getattr(skill, "name", "") or "").strip()
        if not skill_name:
            continue
        if skill_name.lower() == current_normalized:
            continue
        score = 0
        if skill_name.lower() in text:
            score += 100
        if score <= 0:
            continue
        item = {
            "id": getattr(skill, "id", skill_name),
            "name": skill_name,
            "description": getattr(skill, "description", None),
            "metadata": getattr(skill, "metadata", {}) or {},
        }
        if score > best_score:
            best = item
            best_score = score
    return best


def _has_handoff_artifacts(tool_results: list[ToolCallResult | dict[str, Any]]) -> list[str]:
    artifacts = _extract_generated_file_candidates(tool_results)
    return [item for item in artifacts if str(item).strip()]


def _inject_skill_script_artifacts(
    action: PlanStep,
    prior_results: list[ToolCallResult],
    session_id: str,
) -> None:
    if (action.tool or "").strip() != "skill_script_runner":
        return
    params = action.params if isinstance(action.params, dict) else {}
    command = str(params.get("command") or "").strip()
    if not command:
        return
    try:
        parts = shlex.split(command, posix=True)
    except Exception:
        return
    if not parts:
        return

    generated = _extract_generated_file_candidates(prior_results)
    if not generated:
        return

    preferred_by_flag: dict[str, tuple[str, ...]] = {
        "--report": (".md", ".markdown"),
        "-r": (".md", ".markdown"),
        "--md": (".md", ".markdown"),
        "--markdown": (".md", ".markdown"),
        "--html": (".html",),
        "--input": (".md", ".markdown", ".html", ".json", ".txt"),
    }

    replaced = False
    idx = 0
    while idx < len(parts) - 1:
        token = parts[idx]
        if token not in preferred_by_flag:
            idx += 1
            continue
        current_value = str(parts[idx + 1]).strip()
        if not current_value or current_value.startswith("-") or current_value.startswith("/"):
            idx += 2
            continue
        replacement = _pick_generated_file(generated, preferred_by_flag[token])
        if replacement:
            parts[idx + 1] = replacement
            replaced = True
        idx += 2

    if replaced:
        rewritten = shlex.join(parts)
        params["command"] = rewritten
        action.params = params
        logger.info(
            "skill_script_runner_artifact_injected",
            extra={
                "session_id": session_id,
                "step_id": action.id,
                "command": rewritten,
            },
        )


def _get_planner_tool_names(available_schemas: list[dict[str, Any]]) -> set[str]:
    names: set[str] = set()
    for schema in available_schemas:
        if not isinstance(schema, dict):
            continue
        fn = schema.get("function")
        if isinstance(fn, dict):
            name = str(fn.get("name") or "").strip()
            if name:
                names.add(name)
                continue
        name = str(schema.get("name") or "").strip()
        if name:
            names.add(name)
    return names


def _expand_skill_aliases(
    *,
    skill_id: str,
    skill_name: str,
    aliases: list[str],
    tags: list[str],
    description: str,
) -> set[str]:
    expanded: set[str] = set()

    def _push(raw: str) -> None:
        value = str(raw or "").strip().lower()
        if not value:
            return
        expanded.add(value)
        compact = _re.sub(r"[\s._:/-]+", "", value)
        if compact:
            expanded.add(compact)
        normalized = _re.sub(r"[\s._:/-]+", " ", value).strip()
        if normalized:
            expanded.add(normalized)
            expanded.add(normalized.replace(" ", "-"))

    for text in [skill_id, skill_name, description, *aliases, *tags]:
        _push(text)

    # Generate Chinese alias phrases from common english token combos in skill id/name.
    token_text = f"{skill_id} {skill_name}".lower()
    latin_tokens = _re.findall(r"[a-z0-9]+", token_text)
    mapped_tokens: list[tuple[str, ...]] = []
    for token in latin_tokens:
        synonyms = _SKILL_TOKEN_I18N_ALIASES.get(token)
        if synonyms:
            mapped_tokens.append(synonyms[:2])
    if mapped_tokens:
        for combo in product(*mapped_tokens):
            phrase = "".join(combo).strip()
            if phrase:
                expanded.add(phrase)
                expanded.add(f"{phrase}技能")

    return {item for item in expanded if item}


def _pick_skill_candidate(runtime_context: Any, user_text: str) -> dict[str, Any] | None:
    metadata = getattr(runtime_context, "metadata", None)
    if not isinstance(metadata, dict):
        return None
    raw = metadata.get("skill_index")
    if not isinstance(raw, list):
        return None

    raw_text = (user_text or "").strip()
    text = raw_text.lower()
    if not text:
        return None

    import re as _token_re

    def _tokenize(value: str) -> list[str]:
        lowered = (value or "").lower()
        latin = _token_re.findall(r"[a-z0-9._:/-]+", lowered)
        # Keep contiguous CJK spans and generate short n-grams so
        # "使用深度研究技能..." can still match alias "深度研究".
        cjk_spans = _token_re.findall(r"[\u4e00-\u9fff]+", lowered)
        cjk_parts: list[str] = []
        for span in cjk_spans:
            if len(span) < 2:
                continue
            cjk_parts.append(span)
            max_n = min(6, len(span))
            for n in range(2, max_n + 1):
                for i in range(0, len(span) - n + 1):
                    cjk_parts.append(span[i:i + n])
        seen: set[str] = set()
        out: list[str] = []
        for token in (latin + cjk_parts):
            if not token or token in seen:
                continue
            seen.add(token)
            out.append(token)
        return out

    user_tokens = _tokenize(raw_text)
    if not user_tokens:
        return None

    best: dict[str, Any] | None = None
    best_score = -1
    best_tie_key = ""
    for item in raw:
        if not isinstance(item, dict):
            continue
        skill_id = str(item.get("id") or item.get("name") or "").strip()
        if not skill_id:
            continue
        skill_name = str(item.get("name") or "").strip()
        aliases = [str(a).strip() for a in (item.get("aliases") or []) if isinstance(a, str) and str(a).strip()]
        tags = [str(tag).strip() for tag in (item.get("tags") or []) if isinstance(tag, str) and str(tag).strip()]
        description = str(item.get("description") or "").strip()
        expanded_aliases = _expand_skill_aliases(
            skill_id=skill_id,
            skill_name=skill_name,
            aliases=aliases,
            tags=tags,
            description=description,
        )
        name_tokens = _tokenize(" ".join([skill_id, skill_name, *expanded_aliases]))
        desc_tokens = _tokenize(description)
        tag_tokens = _tokenize(" ".join(tags))
        name_token_set = set(name_tokens)
        desc_token_set = set(desc_tokens)
        tag_token_set = set(tag_tokens)
        available = bool(item.get("enabled", True))

        score = 0
        exact_match = any(alias in text for alias in expanded_aliases)
        if exact_match:
            score += 100
        score += 6 * sum(1 for token in user_tokens if token in name_token_set)
        score += 3 * sum(1 for token in user_tokens if token in desc_token_set)
        score += 4 * sum(1 for token in user_tokens if token in tag_token_set)
        if not available:
            score -= 20

        # Tie-breakers: availability > specificity (short desc + fewer tags) > lexical order
        specificity = -((len(description) // 40) + len(tags))
        tie_key = f"{1 if available else 0}:{specificity}:{skill_id.lower()}"

        if score > best_score or (score == best_score and tie_key > best_tie_key):
            best = item
            best_score = score
            best_tie_key = tie_key

    if best_score <= 0:
        return None
    return best


def _is_explicit_skill_execution_request(user_text: str, skill_item: dict[str, Any] | None) -> bool:
    if not user_text or not isinstance(skill_item, dict):
        return False
    skill_name = str(skill_item.get("id") or skill_item.get("name") or "").strip().lower()
    if not skill_name:
        return False
    text = user_text.strip().lower()
    if skill_name not in text:
        return False
    cn_exec = ("使用" in user_text and "技能" in user_text) or ("调用" in user_text and "技能" in user_text)
    en_exec = "use" in text and "skill" in text
    return cn_exec or en_exec


def _inject_minimum_execution_step(
    plan: ExecutionPlan,
    available_tool_names: set[str],
    user_text: str,
    session_id: str,
) -> bool:
    if plan.steps:
        return False
    fallback_tool = None
    for name in ("search", "web_fetch", "browser_automation", "code_executor", "file_io"):
        if name in available_tool_names:
            fallback_tool = name
            break
    if not fallback_tool:
        return False

    params: dict[str, Any]
    if fallback_tool == "search":
        params = {"query": user_text.strip() or "latest updates"}
    elif fallback_tool == "web_fetch":
        params = {"query": user_text.strip() or "latest updates"}
    else:
        params = {"query": user_text.strip() or "latest updates"}

    plan.steps.append(
        PlanStep(
            id="forced_exec_1",
            title="执行最小可行研究步骤",
            tool=fallback_tool,
            params=params,
            parallel=False,
        )
    )
    logger.info(
        "minimum_execution_step_injected",
        extra={"session_id": session_id, "tool": fallback_tool},
    )
    return True


def _resolve_skill_kind_from_item(skill_item: dict[str, Any]) -> str:
    return "skill"


def _has_skill_md_in_item(skill_item: dict[str, Any]) -> bool:
    inventory = skill_item.get("file_inventory")
    if isinstance(inventory, dict) and inventory.get("has_skill_md") is True:
        return True
    pkg = skill_item.get("package")
    files = pkg.get("files") if isinstance(pkg, dict) else None
    if not isinstance(files, list):
        return False
    return any(str(f.get("path") or "") == "SKILL.md" for f in files if isinstance(f, dict))


def _memory_message_content(message: Message | dict[str, str] | Any) -> str:
    if isinstance(message, dict):
        return str(message.get("content") or "")
    return str(getattr(message, "content", "") or "")


def _sanitize_planner_memory(raw_memory: str) -> str:
    text = str(raw_memory or "").strip()
    if not text:
        return ""

    text = _re.sub(r"(?is)<skill_md>.*?</skill_md>", "", text)
    text = _re.sub(
        r"(?ims)^\[user\]\s*\[SYSTEM\]\s*REPLAN[\s\S]*?(?=^\[(?:user|assistant|system)\]\s|\Z)",
        "",
        text,
    )

    turn_regex = _re.compile(
        r"(?ims)^\[(user|assistant|system)\]\s*[\s\S]*?(?=^\[(?:user|assistant|system)\]\s|\Z)"
    )
    turn_matches = list(turn_regex.finditer(text))
    if not turn_matches:
        return text[:_PLANNER_MEMORY_MAX_CHARS]

    prefix = text[: turn_matches[0].start()].strip()
    turns: list[tuple[str, str]] = []
    for match in turn_matches:
        role = str(match.group(1) or "").strip().lower()
        block = match.group(0).strip()
        if not block:
            continue
        lower = block.lower()
        if role == "system":
            continue
        if "[system] replan" in lower:
            continue
        if "<skill_md>" in lower or "</skill_md>" in lower:
            continue
        if role == "assistant" and len(block) > _PLANNER_MEMORY_MAX_ASSISTANT_TURN_CHARS:
            block = (
                block[: _PLANNER_MEMORY_MAX_ASSISTANT_TURN_CHARS].rstrip()
                + "\n...(assistant history truncated)..."
            )
        turns.append((role, block))

    if not turns:
        return prefix[:_PLANNER_MEMORY_MAX_CHARS] if prefix else ""

    kept_reversed: list[tuple[str, str]] = []
    kept_chars = 0
    for role, block in reversed(turns):
        candidate = block
        candidate_chars = len(candidate) + 2
        remaining = _PLANNER_MEMORY_MAX_CHARS - kept_chars
        if remaining <= 0:
            break
        if candidate_chars > remaining:
            if role != "user":
                continue
            min_keep = 120
            if remaining < min_keep:
                continue
            candidate = candidate[: max(0, remaining - 24)].rstrip() + "\n...(truncated)..."
            candidate_chars = len(candidate) + 2
        kept_reversed.append((role, candidate))
        kept_chars += candidate_chars
        if kept_chars >= _PLANNER_MEMORY_MAX_CHARS:
            break

    kept_turns = list(reversed(kept_reversed))
    if not any(role == "user" for role, _ in kept_turns):
        latest_user = next((block for role, block in reversed(turns) if role == "user"), "")
        if latest_user:
            latest_user = latest_user[: max(160, _PLANNER_MEMORY_MAX_CHARS // 2)].rstrip()
            kept_turns = [("user", latest_user)]

    parts: list[str] = []
    if prefix:
        parts.append(prefix)
    parts.extend(block for _, block in kept_turns)
    return "\n\n".join(part for part in parts if part.strip()).strip()[:_PLANNER_MEMORY_MAX_CHARS]


def _get_or_create_skill_injection_tracker(
    runtime_context: Any | None,
    messages: list[Message | dict[str, Any]],
) -> SkillInjectionTracker:
    if runtime_context is None:
        raw_messages = [msg for msg in messages if isinstance(msg, dict)]
        return SkillInjectionTracker.rebuild_from_messages(raw_messages)
    tracker = getattr(runtime_context, "skill_injection_tracker", None)
    if isinstance(tracker, SkillInjectionTracker):
        return tracker
    raw_messages = [msg for msg in messages if isinstance(msg, dict)]
    tracker = SkillInjectionTracker.rebuild_from_messages(raw_messages)
    runtime_context.skill_injection_tracker = tracker
    return tracker


def _inject_skill_index_message(
    messages: list[Message | dict[str, str]],
    runtime_context: Any | None,
    user_text: str,
    tracker: SkillInjectionTracker | None,
) -> bool:
    metadata = getattr(runtime_context, "metadata", None)
    if not isinstance(metadata, dict):
        return False
    raw = metadata.get("skill_index")
    if not isinstance(raw, list):
        return False

    entries = build_skill_index_entries([row for row in raw if isinstance(row, dict)])
    if not entries:
        return False

    text = (user_text or "").strip().lower()
    injected = set(tracker.get_injected_skills()) if isinstance(tracker, SkillInjectionTracker) else set()

    def _score(entry: Any) -> tuple[int, str]:
        score = 0
        if entry.skill_id.lower() in text or entry.name.lower() in text:
            score += 100
        if entry.skill_id in injected:
            score += 20
        if entry.description:
            score += min(
                10,
                sum(
                    1
                    for token in _re.findall(r"[a-z0-9\u4e00-\u9fff]+", entry.description.lower())
                    if token and token in text
                ),
            )
        return score, entry.skill_id

    ordered = sorted(entries, key=_score, reverse=True)
    payload = format_skills_for_prompt(
        ordered,
        max_skills=_MAX_SKILLS_IN_PROMPT,
        max_chars=_MAX_SKILLS_PROMPT_CHARS,
        max_desc_chars=_MAX_SKILL_DESC_CHARS,
    )
    messages.append({"role": "system", "content": payload})
    return True


def _inject_skill_constraints_message(
    messages: list[Message | dict[str, str]],
    skill_item: dict[str, Any] | None,
    available_tool_names: set[str],
    *,
    skill_md_preloaded: bool = False,
) -> None:
    if not skill_item:
        return
    skill_name = str(skill_item.get("id") or skill_item.get("name") or "").strip()
    if not skill_name:
        return
    has_skill_md = _has_skill_md_in_item(skill_item)
    constraints = [
        f"[SYSTEM] Skill orchestration constraints for selected skill: {skill_name}",
        "- single-round single-skill: only this selected skill may guide the current plan.",
        "- if execution fails in this round, replan within the same selected skill's methodology before considering generic fallbacks.",
        "- installer is fallback only; use existing tools/skills first.",
        "- if you still need skill_installer, include params.missing_capabilities (array) and params.evidence (array).",
    ]
    if has_skill_md:
        if skill_md_preloaded:
            constraints.append("- SKILL.md has been injected for this planning round; do NOT add read_skill_file(SKILL.md) as an execution step.")
        elif "file_io" in available_tool_names:
            constraints.append("- SKILL.md is not preloaded; you may call file_io with action='read_skill_file' before execution if more detail is needed.")
        else:
            constraints.append("- read and follow SKILL.md guidance before reading scripts/reference/templates.")
    constraints.append(f"- do NOT call tool '{skill_name}' directly; a skill is not a fixed entrypoint tool.")
    constraints.append(
        "- do NOT replace this skill's methodological phases with generic code_executor/file_io/pdf steps unless SKILL.md explicitly instructs that transformation."
    )
    if "skill_script_runner" in available_tool_names:
        constraints.append(
            "- for executable script steps, use tool='skill_script_runner' with params "
            "{skill_name: <skill>, command: '<bash command that references scripts/...>'}."
        )
        constraints.append(
            "- command must be derived from SKILL.md instructions, "
            "not from a hard-coded runtime entry script."
        )
    else:
        constraints.append("- skill_script_runner not available; fallback to builtin tools while following SKILL.md.")

    messages.append(
        {
            "role": "user",
            "content": "\n".join(constraints),
        }
    )


def _extract_script_commands_from_skill_md(skill_md_content: str) -> list[str]:
    text = str(skill_md_content or "")
    if not text:
        return []
    seen: set[str] = set()
    commands: list[str] = []
    patterns = [
        r"python(?:3(?:\.\d+)?)?\s+scripts/[^\n`]+",
        r"python(?:3(?:\.\d+)?)?\s+[A-Za-z0-9_.-]+\.(?:py|sh|js|mjs|cjs)(?:\s+[^\n`]+)?",
        r"node\s+scripts/[^\n`]+",
        r"node\s+[A-Za-z0-9_.-]+\.(?:js|mjs|cjs)(?:\s+[^\n`]+)?",
        r"bash\s+scripts/[^\n`]+",
        r"bash\s+[A-Za-z0-9_.-]+\.(?:sh|bash)(?:\s+[^\n`]+)?",
        r"sh\s+scripts/[^\n`]+",
        r"sh\s+[A-Za-z0-9_.-]+\.(?:sh|bash)(?:\s+[^\n`]+)?",
        r"pnpm\s+[^\n`]*scripts/[^\n`]+",
        r"npm\s+run\s+[^\n`]*",
        r"\./scripts/[^\s`]+(?:\s+[^\n`]*)?",
    ]
    for pat in patterns:
        for match in _re.finditer(pat, text, flags=_re.IGNORECASE):
            command = " ".join(str(match.group(0) or "").strip().split())
            if not command:
                continue
            lowered = command.lower()
            if lowered in seen:
                continue
            seen.add(lowered)
            commands.append(command)
    return commands


def _materialize_skill_script_command(raw_command: str) -> str:
    command = str(raw_command or "").strip()
    if not command:
        return command
    replacements = {
        "[path]": "research_report.md",
        "[report_path]": "research_report.md",
        "[markdown_report_path]": "research_report.md",
        "[html_path]": "research_report.html",
        "[md_path]": "research_report.md",
    }
    for key, value in replacements.items():
        command = command.replace(key, value)
    return command


def _extract_skill_script_files(skill_item: dict[str, Any] | None) -> list[str]:
    if not isinstance(skill_item, dict):
        return []
    files: list[str] = []
    package = skill_item.get("package")
    package_files = package.get("files") if isinstance(package, dict) else None
    if isinstance(package_files, list):
        for item in package_files:
            if not isinstance(item, dict):
                continue
            path = str(item.get("path") or "").strip().replace("\\", "/")
            if path.startswith("scripts/"):
                files.append(path)

    skill_name = str(skill_item.get("id") or skill_item.get("name") or "").strip()
    if not skill_name:
        return sorted(set(files))
    try:
        skills_root = Path(os.getenv("SEMIBOT_SKILLS_PATH", "~/.semibot/skills")).expanduser().resolve()
        skill_root = (skills_root / skill_name).resolve()
        scripts_dir = (skill_root / "scripts").resolve()
        if scripts_dir.exists() and scripts_dir.is_dir() and (skill_root == skills_root or skills_root in skill_root.parents):
            for path in scripts_dir.rglob("*"):
                if path.is_file():
                    files.append(str(path.relative_to(skill_root)).replace("\\", "/"))
    except Exception:
        pass
    return sorted(set(files))


def _extract_skill_script_interfaces(
    skill_item: dict[str, Any] | None,
    script_files: list[str],
) -> list[str]:
    if not isinstance(skill_item, dict) or not script_files:
        return []
    skill_name = str(skill_item.get("id") or skill_item.get("name") or "").strip()
    if not skill_name:
        return []
    try:
        skills_root = Path(os.getenv("SEMIBOT_SKILLS_PATH", "~/.semibot/skills")).expanduser().resolve()
        skill_root = (skills_root / skill_name).resolve()
        if skill_root != skills_root and skills_root not in skill_root.parents:
            return []
        return _SCRIPT_CLI_ADVISOR.describe_script_interfaces(skill_root, script_files)
    except Exception:
        return []


def _normalize_step_skill_sources(plan: ExecutionPlan) -> None:
    for step in plan.steps:
        if (step.tool or "").strip() != "skill_script_runner":
            continue
        if step.skill_source:
            continue
        skill_name = str((step.params or {}).get("skill_name") or "").strip()
        if skill_name:
            step.skill_source = skill_name


def _validate_plan_provenance(plan: ExecutionPlan) -> list[str]:
    errors: list[str] = []
    for idx, step in enumerate(plan.steps):
        if (step.tool or "").strip() != "skill_script_runner":
            continue
        declared = str(step.skill_source or "").strip()
        actual = str((step.params or {}).get("skill_name") or "").strip()
        if not declared:
            errors.append(f"step {idx}: skill_script_runner step missing skill_source")
            continue
        if actual and actual != declared:
            errors.append(f"step {idx}: skill_source '{declared}' does not match skill_name '{actual}'")
        command = str((step.params or {}).get("command") or "").strip()
        if not command:
            errors.append(f"step {idx}: skill_script_runner step missing params.command")
            continue
        command_lower = command.lower()
        has_scripts_ref = "scripts/" in command_lower or "scripts\\" in command_lower
        has_script_filename = bool(
            _re.search(r"\b[a-z0-9_.-]+\.(?:py|js|mjs|cjs|sh|bash|ts)\b", command_lower)
        )
        if not (has_scripts_ref or has_script_filename):
            errors.append(
                f"step {idx}: skill_script_runner command must reference a script file under scripts/, got: {command}"
            )
    return errors


def _enforce_hybrid_skill_script_runner_step(
    plan: ExecutionPlan,
    skill_item: dict[str, Any] | None,
    available_tool_names: set[str],
    script_commands: list[str],
    session_id: str,
) -> bool:
    if not isinstance(skill_item, dict):
        return False
    if "skill_script_runner" not in available_tool_names:
        return False
    if any((step.tool or "").strip() == "skill_script_runner" for step in plan.steps):
        return False

    skill_name = str(skill_item.get("id") or skill_item.get("name") or "").strip()
    if not skill_name:
        return False

    selected_command = ""
    for command in script_commands:
        materialized = _materialize_skill_script_command(command)
        if "scripts/" in materialized:
            selected_command = materialized
            break
    if not selected_command:
        return False

    plan.steps.append(
        PlanStep(
            id=f"{skill_name}_script_1",
            title=f"执行{skill_name}技能脚本",
            tool="skill_script_runner",
            params={"skill_name": skill_name, "command": selected_command},
            parallel=False,
        )
    )
    logger.info(
        "hybrid_skill_script_runner_step_injected",
        extra={"session_id": session_id, "skill_name": skill_name, "command": selected_command},
    )
    return True


def _extract_skill_md_for_planner(skill_item: dict[str, Any] | None) -> tuple[str, bool]:
    if not isinstance(skill_item, dict):
        return "", False
    package = skill_item.get("package")
    files = package.get("files") if isinstance(package, dict) else None
    if not isinstance(files, list):
        return "", False

    for file_item in files:
        if not isinstance(file_item, dict):
            continue
        path = str(file_item.get("path") or "").strip()
        if path != "SKILL.md":
            continue
        content = str(file_item.get("content") or "")
        if not content:
            return "", False
        if len(content) <= _PLANNER_SKILL_MD_MAX_CHARS:
            return content, False
        return content[:_PLANNER_SKILL_MD_MAX_CHARS], True
    return "", False


def _load_skill_md_for_planner(skill_item: dict[str, Any] | None) -> tuple[str, bool]:
    content, truncated = _extract_skill_md_for_planner(skill_item)
    if content:
        return content, truncated
    if not isinstance(skill_item, dict):
        return "", False
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


def _inject_skill_md_context_message(
    messages: list[Message | dict[str, str]],
    skill_item: dict[str, Any] | None,
    session_id: str,
    tracker: SkillInjectionTracker | None = None,
) -> bool:
    if not skill_item:
        return False
    skill_name = str(skill_item.get("id") or skill_item.get("name") or "").strip()
    if not skill_name:
        return False

    normalized_skill_name = _re.sub(r"[^a-zA-Z0-9_.-]+", "-", skill_name).strip("-") or "unknown-skill"
    normalized_call_id = _re.sub(r"[^a-zA-Z0-9_]+", "_", skill_name).strip("_") or "unknown_skill"
    tool_context_name = f"{_SKILL_CONTEXT_TOOL_NAME_PREFIX}/{normalized_skill_name}"
    tool_context_call_id = f"{_SKILL_CONTEXT_TOOL_CALL_ID_PREFIX}{normalized_call_id}"

    skill_md_content, truncated = _load_skill_md_for_planner(skill_item)
    if not skill_md_content:
        return False

    header = [
        f"[TOOL_CONTEXT] Selected skill '{skill_name}' SKILL.md has been preloaded for planning.",
        "- Treat this as tool-side reference context, not as user intent.",
        "- You MUST follow this skill guidance when creating the first executable plan.",
    ]
    if truncated:
        header.append(
            f"- SKILL.md content is truncated to first {_PLANNER_SKILL_MD_MAX_CHARS} chars; if needed, read full file via file_io.read_skill_file in first steps."
        )
    payload = "\n".join(header) + "\n\n<skill_md>\n" + skill_md_content + "\n</skill_md>"
    messages.append(
        {
            "role": "tool",
            "name": tool_context_name,
            "tool_call_id": tool_context_call_id,
            "content": payload,
        }
    )
    if isinstance(tracker, SkillInjectionTracker):
        tracker.mark_injected(
            skill_name,
            chars=len(skill_md_content),
            content=payload,
            content_mtime=current_mtime if "current_mtime" in locals() else None,
        )
    logger.info(
        "skill_md_context_injected_for_initial_plan",
        extra={
            "session_id": session_id,
            "skill_name": skill_name,
            "truncated": truncated,
            "chars": len(skill_md_content),
        },
    )
    return True


def _enforce_skill_md_gate_step(
    plan: ExecutionPlan,
    skill_item: dict[str, Any] | None,
    available_tool_names: set[str],
    session_id: str,
) -> None:
    if not skill_item or "file_io" not in available_tool_names:
        return
    if not _has_skill_md_in_item(skill_item):
        return
    skill_name = str(skill_item.get("id") or skill_item.get("name") or "").strip()
    if not skill_name:
        return
    if plan.steps and (plan.steps[0].tool or "").strip() == "file_io":
        first_action = str((plan.steps[0].params or {}).get("action") or "").strip().lower()
        if first_action == "read_skill_file":
            return
    if plan.steps and (plan.steps[0].tool or "").strip() == "read_skill_file":
        return
    plan.steps.insert(
        0,
        PlanStep(
            id="skill_read_1",
            title="读取技能说明文档",
            tool="file_io",
            params={"action": "read_skill_file", "skill_name": skill_name, "file_path": "SKILL.md"},
            parallel=False,
        ),
    )
    logger.info(
        "skill_md_gate_step_injected",
        extra={"session_id": session_id, "skill_name": skill_name},
    )


def _is_report_synthesis_step(step: PlanStep) -> bool:
    text = " ".join(
        [
            str(step.title or ""),
            str(step.params.get("query") or ""),
            str(step.params.get("task") or ""),
            str(step.params.get("goal") or ""),
        ]
    ).strip()
    if not text:
        return False
    lower = text.lower()
    has_synthesis_intent = any(token in text for token in _REPORT_SYNTHESIS_KEYWORDS) or any(
        token in lower for token in _REPORT_SYNTHESIS_KEYWORDS
    )
    if not has_synthesis_intent:
        return False
    has_retrieval_intent = any(token in text for token in _REPORT_RETRIEVAL_KEYWORDS) or any(
        token in lower for token in _REPORT_RETRIEVAL_KEYWORDS
    )
    return not has_retrieval_intent


def _build_report_writer_code(*, report_path: str, heading: str) -> str:
    normalized_path = (report_path or "report.md").strip() or "report.md"
    if normalized_path.startswith("/"):
        normalized_path = normalized_path.split("/")[-1] or "report.md"
    heading_literal = json.dumps((heading or "Research Report").strip() or "Research Report", ensure_ascii=False)
    path_literal = json.dumps(normalized_path, ensure_ascii=False)
    return (
        "import datetime\n"
        "import json\n"
        "import os\n\n"
        f"report_title = {heading_literal}\n"
        f"report_path = {path_literal}\n"
        "context_path = 'context.json'\n"
        "lines = [\n"
        "    f'# {report_title}',\n"
        "    '',\n"
        "    f'Generated at: {datetime.datetime.now().isoformat()}',\n"
        "    '',\n"
        "]\n\n"
        "if os.path.exists(context_path):\n"
        "    with open(context_path, 'r', encoding='utf-8') as f:\n"
        "        payload = json.load(f)\n"
        "    rows = payload.get('results') or payload.get('search_results') or []\n"
        "    if isinstance(rows, list) and rows:\n"
        "        lines.append('## Key Findings')\n"
        "        lines.append('')\n"
        "        for idx, item in enumerate(rows[:12], start=1):\n"
        "            if isinstance(item, dict):\n"
        "                title = str(item.get('title') or item.get('name') or f'Source {idx}').strip()\n"
        "                url = str(item.get('url') or '').strip()\n"
        "                content = str(item.get('content') or item.get('snippet') or '').strip()\n"
        "            else:\n"
        "                title = f'Source {idx}'\n"
        "                url = ''\n"
        "                content = str(item).strip()\n"
        "            lines.append(f'### {idx}. {title}')\n"
        "            if url:\n"
        "                lines.append(f'- URL: {url}')\n"
        "            if content:\n"
        "                lines.append(f'- Summary: {content[:500]}')\n"
        "            lines.append('')\n"
        "    else:\n"
        "        lines.append('No structured context data was available. Please rerun with retrieval context.')\n"
        "else:\n"
        "    lines.append('No context.json found. Please provide retrieval context before report generation.')\n\n"
        "with open(report_path, 'w', encoding='utf-8') as f:\n"
        "    f.write('\\n'.join(lines).strip() + '\\n')\n\n"
        "print(json.dumps({'report_file': report_path, 'line_count': len(lines)}, ensure_ascii=False))\n"
    )


def _enforce_report_synthesis_tool_preference(
    steps: list[PlanStep],
    available_tool_names: set[str],
    session_id: str,
    *,
    selected_skill_name: str | None = None,
) -> int:
    if selected_skill_name:
        return 0
    if "code_executor" not in available_tool_names:
        return 0
    rewritten = 0
    for step in steps:
        if not _is_report_synthesis_step(step):
            continue
        if not _is_search_tool(step.tool):
            continue
        heading = str(step.title or step.params.get("query") or "Research Report").strip()
        existing_context = step.params.get("context_data")
        step.tool = "code_executor"
        step.params = {
            "language": "python",
            "code": _build_report_writer_code(report_path="report.md", heading=heading),
        }
        if isinstance(existing_context, str) and existing_context.strip():
            step.params["context_data"] = existing_context
        rewritten += 1
        logger.info(
            "report_synthesis_tool_rewritten",
            extra={"session_id": session_id, "step_id": step.id, "to": "code_executor"},
        )
    return rewritten


def _enforce_file_io_write_params(
    steps: list[PlanStep],
    available_tool_names: set[str],
    session_id: str,
    *,
    selected_skill_name: str | None = None,
) -> int:
    if selected_skill_name:
        return 0
    rewritten = 0
    can_use_code_executor = "code_executor" in available_tool_names
    for step in steps:
        if (step.tool or "").strip() != "file_io":
            continue
        params = step.params if isinstance(step.params, dict) else {}
        action = str(params.get("action") or params.get("operation") or "").strip().lower()
        if action != "write":
            continue

        path = str(params.get("path") or "").strip()
        content = params.get("content")
        has_path = bool(path)
        has_content = isinstance(content, str) and content != ""

        if has_path and has_content:
            continue

        if (not has_path) and has_content:
            params["path"] = "report.md"
            step.params = params
            rewritten += 1
            logger.info(
                "file_io_write_missing_path_filled",
                extra={"session_id": session_id, "step_id": step.id, "path": "report.md"},
            )
            continue

        heading = str(step.title or params.get("query") or "Research Report").strip()
        target_path = path or "report.md"
        if can_use_code_executor:
            existing_context = params.get("context_data")
            step.tool = "code_executor"
            step.params = {
                "language": "python",
                "code": _build_report_writer_code(report_path=target_path, heading=heading),
            }
            if isinstance(existing_context, str) and existing_context.strip():
                step.params["context_data"] = existing_context
            rewritten += 1
            logger.info(
                "file_io_write_rewritten_to_code_executor",
                extra={"session_id": session_id, "step_id": step.id},
            )
            continue

        step.params = {
            "action": "write",
            "path": target_path,
            "content": f"# {heading}\n\nNo content generated. Please re-run with retrieval context.\n",
        }
        rewritten += 1
        logger.warning(
            "file_io_write_autofixed_with_placeholder",
            extra={"session_id": session_id, "step_id": step.id},
        )
    return rewritten


def _normalize_skill_read_step_order(
    plan: ExecutionPlan,
    session_id: str,
) -> bool:
    if not plan.steps:
        return False
    read_idx = -1
    for idx, step in enumerate(plan.steps):
        if (step.tool or "").strip() != "file_io":
            continue
        action = str((step.params or {}).get("action") or (step.params or {}).get("operation") or "").strip().lower()
        if action == "read_skill_file":
            read_idx = idx
            break
    if read_idx < 0:
        return False

    changed = False
    if read_idx != 0:
        step = plan.steps.pop(read_idx)
        plan.steps.insert(0, step)
        changed = True
    for step in plan.steps:
        if step.parallel:
            step.parallel = False
            changed = True
    if changed:
        logger.info(
            "skill_read_step_order_normalized",
            extra={"session_id": session_id},
        )
    return changed


def _drop_skill_read_steps(plan: ExecutionPlan, session_id: str) -> int:
    if not plan.steps:
        return 0
    kept: list[PlanStep] = []
    dropped = 0
    for step in plan.steps:
        tool_name = str(step.tool or "").strip()
        params = step.params if isinstance(step.params, dict) else {}
        action = str(params.get("action") or params.get("operation") or "").strip().lower()
        is_skill_read = (
            tool_name == "read_skill_file"
            or (tool_name == "file_io" and action == "read_skill_file")
        )
        if is_skill_read:
            dropped += 1
            continue
        kept.append(step)
    if dropped:
        plan.steps = kept
        logger.info(
            "skill_read_steps_dropped_after_prompt_injection",
            extra={"session_id": session_id, "dropped": dropped},
        )
    return dropped


def _sanitize_plan_tool_names(
    plan: ExecutionPlan,
    available_tool_names: set[str],
    skill_item: dict[str, Any] | None,
    session_id: str,
    skill_registry: Any | None = None,
    blocked_skill_names: set[str] | None = None,
) -> dict[str, int]:
    if not plan.steps:
        return {"rewritten": 0, "dropped": 0}

    selected_skill_name = (
        str(skill_item.get("id") or skill_item.get("name") or "").strip()
        if isinstance(skill_item, dict)
        else ""
    )
    def _fallback_tool() -> str | None:
        for name in ("search", "web_fetch", "browser_automation", "code_executor", "file_io"):
            if name in available_tool_names:
                return name
        return None

    fallback = _fallback_tool()
    rewritten = 0
    dropped = 0
    next_steps: list[PlanStep] = []

    for step in plan.steps:
        tool_name = str(step.tool or "").strip()
        replacement: str | None = None
        if tool_name and blocked_skill_names and tool_name in blocked_skill_names:
            replacement = fallback
        elif tool_name and selected_skill_name and tool_name == selected_skill_name:
            replacement = fallback
        elif (
            tool_name
            and tool_name in available_tool_names
            and skill_registry is not None
            and hasattr(skill_registry, "get_tool")
            and callable(getattr(skill_registry, "get_tool"))
            and getattr(skill_registry, "get_tool")(tool_name) is None
        ):
            replacement = fallback
        elif tool_name and tool_name in available_tool_names:
            if tool_name == "json_transform":
                params = step.params if isinstance(step.params, dict) else {}
                has_data = "data" in params and params.get("data") not in (None, "")
                if not has_data:
                    replacement = "code_executor" if "code_executor" in available_tool_names else fallback
                if replacement:
                    pass
                else:
                    next_steps.append(step)
                    continue
            else:
                next_steps.append(step)
                continue
        elif not tool_name:
            replacement = fallback
        elif fallback:
            replacement = fallback

        if replacement:
            query_seed = str(step.params.get("query") or step.title or selected_skill_name or "").strip()
            if replacement == "search":
                step.params = {"query": query_seed or "latest updates"}
            elif replacement == "code_executor":
                step.params = {
                    "language": "python",
                    "code": (
                        "import json\n"
                        f"task = {json.dumps(query_seed or step.title or 'process data', ensure_ascii=False)}\n"
                        "print(json.dumps({'task': task, 'note': 'json_transform missing data; rewritten to code_executor'}, ensure_ascii=False))\n"
                    ),
                }
            step.tool = replacement
            rewritten += 1
            logger.info(
                "plan_tool_rewritten",
                extra={
                    "session_id": session_id,
                    "from": tool_name or "<empty>",
                    "to": replacement,
                },
            )
            next_steps.append(step)
            continue

        dropped += 1
        logger.warning(
            "plan_step_dropped_unexecutable_tool",
            extra={
                "session_id": session_id,
                "tool": tool_name or "<empty>",
                "title": step.title,
            },
        )

    plan.steps = next_steps
    return {"rewritten": rewritten, "dropped": dropped}


def _evaluate_installer_gap(
    step: PlanStep,
    available_tool_names: set[str],
) -> dict[str, Any]:
    missing = step.params.get("missing_capabilities")
    evidence = step.params.get("evidence")
    missing_list = [str(x).strip() for x in missing] if isinstance(missing, list) else []
    evidence_list = [str(x).strip() for x in evidence] if isinstance(evidence, list) else []
    missing_list = [x for x in missing_list if x]
    evidence_list = [x for x in evidence_list if x]
    missing_not_available = [cap for cap in missing_list if cap not in available_tool_names]
    return {
        "step_id": step.id,
        "missing_capabilities": missing_list,
        "missing_not_available": missing_not_available,
        "evidence": evidence_list,
        "gap": bool(missing_not_available),
        "structured": bool(missing_list and evidence_list),
        "allow_install": bool(missing_not_available and missing_list and evidence_list),
    }


def _enforce_structured_installer_gap(
    plan: ExecutionPlan,
    available_tool_names: set[str],
    session_id: str,
) -> dict[str, Any]:
    filtered_steps: list[PlanStep] = []
    dropped = 0
    reports: list[dict[str, Any]] = []
    for step in plan.steps:
        if (step.tool or "").strip() != "skill_installer":
            filtered_steps.append(step)
            continue
        report = _evaluate_installer_gap(step, available_tool_names)
        reports.append(report)
        if report["allow_install"]:
            filtered_steps.append(step)
            continue
        dropped += 1

    if dropped:
        plan.steps = filtered_steps
        logger.info(
            "skill_installer_step_dropped",
            extra={"session_id": session_id, "count": dropped},
        )
    return {"dropped": dropped, "reports": reports}


def _rewrite_unexecutable_pending_actions(
    pending_actions: list[PlanStep],
    runtime_context: Any | None,
    unified_executor: Any | None,
    session_id: str,
) -> tuple[list[PlanStep], int]:
    if not pending_actions:
        return pending_actions, 0

    executable_names: set[str] = {
        "search",
        "web_fetch",
        "browser_automation",
        "code_executor",
        "file_io",
        "http_client",
        "json_transform",
        "csv_xlsx",
        "pdf_report",
        "sql_query_readonly",
        "control_plane",
        "rule_authoring",
        "skill_installer",
        "xlsx",
        "pdf",
    }
    if runtime_context:
        metadata = getattr(runtime_context, "metadata", None)
        registry = metadata.get("skill_registry") if isinstance(metadata, dict) else None
        if registry is not None:
            with suppress(Exception):
                executable_names.update(str(name).strip() for name in registry.list_tools() if str(name).strip())
        available_skills = getattr(runtime_context, "available_skills", None)
        if isinstance(available_skills, list):
            executable_names.difference_update(
                {
                    str(getattr(skill, "name", "")).strip()
                    for skill in available_skills
                    if str(getattr(skill, "name", "")).strip()
                }
            )

    def _is_action_executable(tool_name: str) -> bool:
        if not tool_name:
            return False
        if tool_name in executable_names:
            return True
        capability_graph = getattr(unified_executor, "capability_graph", None)
        if capability_graph is not None and hasattr(capability_graph, "get_capability"):
            try:
                capability = capability_graph.get_capability(tool_name)
            except Exception:
                capability = None
            if capability is not None and str(getattr(capability, "capability_type", "")) == "mcp":
                return True
        return False

    fallback: str | None = None
    for name in ("search", "web_fetch", "browser_automation", "code_executor", "file_io"):
        if _is_action_executable(name):
            fallback = name
            break
    if not fallback:
        return pending_actions, 0

    rewritten = 0
    for action in pending_actions:
        tool_name = str(action.tool or "").strip()
        if _is_action_executable(tool_name):
            continue
        query_seed = str(action.params.get("query") or action.title or tool_name or "latest updates").strip()
        action.tool = fallback
        if fallback == "search":
            action.params = {"query": query_seed}
        rewritten += 1
        logger.warning(
            "pending_action_rewritten_unexecutable_tool",
            extra={
                "session_id": session_id,
                "from": tool_name or "<empty>",
                "to": fallback,
            },
        )

    return pending_actions, rewritten


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

    if runtime_context and (skill_registry is None):
        metadata = getattr(runtime_context, "metadata", None)
        if isinstance(metadata, dict):
            candidate_registry = metadata.get("skill_registry")
            if candidate_registry is not None:
                skill_registry = candidate_registry

    if runtime_context:
        # Use CapabilityGraph to get available capabilities
        from src.orchestrator.capability import CapabilityGraph

        capability_graph = CapabilityGraph(runtime_context)
        available_skills = capability_graph.get_schemas_for_planner()
        available_skills = _merge_dynamic_registry_schemas(available_skills, runtime_context)

        logger.info(
            "Capability graph built for planning",
            extra={
                "session_id": state["session_id"],
                "capability_count": len(available_skills),
            },
        )
    elif skill_registry:
        # Fallback to runtime registry for backward compatibility.
        # Use executable tool schemas only (skills are orchestration-only).
        tool_schemas: list[dict[str, Any]] = []
        get_tool_schemas = getattr(skill_registry, "get_tool_schemas", None)
        if callable(get_tool_schemas):
            try:
                raw_tools = get_tool_schemas()
                if isinstance(raw_tools, list):
                    tool_schemas = [item for item in raw_tools if isinstance(item, dict)]
            except Exception:
                tool_schemas = []
        available_skills = tool_schemas
        if not available_skills and hasattr(skill_registry, "get_all_schemas"):
            try:
                raw_all = skill_registry.get_all_schemas()
                if isinstance(raw_all, list):
                    available_skills = [
                        item
                        for item in raw_all
                        if isinstance(item, dict)
                        and str(item.get("type") or "").strip().lower() != "skill"
                    ]
            except Exception:
                available_skills = []
        logger.warning(
            "Using skill_registry fallback (no RuntimeSessionContext)",
            extra={"session_id": state["session_id"]},
        )

    # Extract state data
    messages = list(state["messages"])
    memory_context = _sanitize_planner_memory(str(state.get("memory_context", "") or ""))
    latest_user_text = str(messages[-1].get("content") or "") if messages else ""
    available_tool_names = _get_planner_tool_names(available_skills)
    skill_injection_tracker = _get_or_create_skill_injection_tracker(runtime_context, messages)

    selected_skill = _pick_skill_candidate(runtime_context, latest_user_text) if runtime_context else None
    selected_skill_md_content, _selected_skill_md_truncated = _load_skill_md_for_planner(selected_skill)
    has_selected_skill_md_for_prompt = bool(selected_skill_md_content)
    blocked_skill_names = {
        str(getattr(skill, "name", "")).strip()
        for skill in getattr(runtime_context, "available_skills", []) or []
        if str(getattr(skill, "name", "")).strip()
    } if runtime_context else set()
    before_rule_filter = len(available_skills)
    available_skills = _filter_rule_authoring_by_intent(available_skills, latest_user_text)
    if len(available_skills) != before_rule_filter:
        logger.info(
            "planner_capability_filtered_by_intent",
            extra={
                "session_id": state["session_id"],
                "removed": before_rule_filter - len(available_skills),
                "reason": "rule_authoring_non_intent",
            },
        )

    # On replan: inject previous tool errors so LLM can learn from failures
    tool_results = state.get("tool_results", [])
    failed_results = [r for r in tool_results if not r.success]
    if failed_results and state["iteration"] > 0:
        # Replan 时避免重复调用已经失败过的能力（尤其外部网络工具），降低“重复失败”噪声。
        failed_names = {r.tool_name for r in failed_results if r.tool_name}
        selected_skill_name = (
            str(selected_skill.get("id") or selected_skill.get("name") or "").strip()
            if isinstance(selected_skill, dict)
            else ""
        )
        sticky_ban: set[str] = set()
        for name in failed_names:
            if not name:
                continue
            if selected_skill_name:
                if name == "skill_script_runner":
                    continue
                sticky_ban.add(name)
                continue
            if name != "code_executor":
                sticky_ban.add(name)
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

    available_tool_names = _get_planner_tool_names(available_skills)

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

        preplan_generated = False
        preview_plan: ExecutionPlan | None = None
        preview_prompt_dump_path = ""
        if selected_skill and has_selected_skill_md_for_prompt:
            if event_emitter:
                await event_emitter.emit_thinking("正在生成预执行计划...", "planning")
            preview_messages = list(messages)
            _inject_skill_index_message(preview_messages, runtime_context, latest_user_text, skill_injection_tracker)
            _inject_skill_constraints_message(
                preview_messages,
                selected_skill,
                available_tool_names,
                skill_md_preloaded=False,
            )
            preview_response = await llm_provider.generate_plan(
                messages=preview_messages,
                memory=effective_memory,
                available_tools=available_skills,
                available_sub_agents=sub_agents_for_planner or None,
                agent_system_prompt=agent_system_prompt,
                model=agent_model,
                debug_meta={
                    "session_id": state["session_id"],
                    "iteration": int(state.get("iteration", 0)),
                    "phase": "preview",
                },
            )
            preview_prompt_dump_path = str(preview_response.get("_prompt_dump_path") or "")
            preview_thinking = preview_response.pop("_thinking", "")
            if event_emitter and preview_thinking:
                await event_emitter.emit_thinking(preview_thinking, "planning")
            preview_plan = parse_plan_response(preview_response)
            if event_emitter and preview_plan.steps:
                await event_emitter.emit(
                    "plan_version",
                    {
                        "version": int(state.get("iteration", 0)) + 1,
                        "is_replan": int(state.get("iteration", 0)) > 0,
                        "phase": "preview",
                        "steps": [
                            {
                                "id": step.id,
                                "title": step.title,
                                "tool": step.tool,
                                "parallel": bool(step.parallel),
                            }
                            for step in preview_plan.steps
                        ],
                    },
                )
            if event_emitter:
                await event_emitter.emit_thinking("正在读取技能说明并修正执行计划...", "planning")
            preplan_generated = True

        planning_messages = list(messages)
        _inject_skill_index_message(planning_messages, runtime_context, latest_user_text, skill_injection_tracker)
        skill_md_prompt_injected = _inject_skill_md_context_message(
            planning_messages, selected_skill, state["session_id"], skill_injection_tracker
        )
        _inject_skill_constraints_message(
            planning_messages,
            selected_skill,
            available_tool_names,
            skill_md_preloaded=skill_md_prompt_injected,
        )

        # Call LLM to generate final executable plan
        plan_response = await llm_provider.generate_plan(
            messages=planning_messages,
            memory=effective_memory,
            available_tools=available_skills,
            available_sub_agents=sub_agents_for_planner or None,
            agent_system_prompt=agent_system_prompt,
            model=agent_model,
            debug_meta={
                "session_id": state["session_id"],
                "iteration": int(state.get("iteration", 0)),
                "phase": "final",
            },
        )
        final_prompt_dump_path = str(plan_response.get("_prompt_dump_path") or "")

        # Emit LLM's reasoning text (non-JSON portion of the response)
        thinking_text = plan_response.pop("_thinking", "")
        if event_emitter and thinking_text:
            await event_emitter.emit_thinking(thinking_text, "planning")

        # Parse plan from response
        plan = parse_plan_response(plan_response)
        if (not plan.steps) and preview_plan and preview_plan.steps:
            logger.warning(
                "final_plan_empty_fallback_to_preview_plan",
                extra={"session_id": state["session_id"]},
            )
            plan = preview_plan
        _normalize_step_skill_sources(plan)
        provenance_errors = _validate_plan_provenance(plan)
        provenance_attempts = 0
        while provenance_errors and provenance_attempts < 2:
            provenance_attempts += 1
            planning_messages.append(
                {
                    "role": "system",
                    "content": (
                        "[SYSTEM] REPLAN: plan provenance validation failed.\n"
                        + "\n".join(provenance_errors)
                        + "\nFix: every skill_script_runner step must declare skill_source matching params.skill_name."
                    ),
                }
            )
            plan_response = await llm_provider.generate_plan(
                messages=planning_messages,
                memory=effective_memory,
                available_tools=available_skills,
                available_sub_agents=sub_agents_for_planner or None,
                agent_system_prompt=agent_system_prompt,
                model=agent_model,
                debug_meta={
                    "session_id": state["session_id"],
                    "iteration": int(state.get("iteration", 0)),
                    "phase": "final_provenance_retry",
                },
            )
            final_prompt_dump_path = str(plan_response.get("_prompt_dump_path") or final_prompt_dump_path)
            plan_response.pop("_thinking", "")
            plan = parse_plan_response(plan_response)
            _normalize_step_skill_sources(plan)
            provenance_errors = _validate_plan_provenance(plan)
        if provenance_errors:
            return {
                "error": "Planning failed: plan provenance validation failed",
                "current_step": "respond",
            }

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
        _enforce_browser_tool_preference(
            steps=plan.steps,
            user_text=user_text,
            available_tool_names=available_tool_names,
            session_id=state["session_id"],
        )
        _enforce_pdf_tool_preference(
            steps=plan.steps,
            user_text=user_text,
            available_tool_names=available_tool_names,
            session_id=state["session_id"],
        )
        _sanitize_plan_tool_names(
            plan=plan,
            available_tool_names=available_tool_names,
            skill_item=selected_skill,
            session_id=state["session_id"],
            skill_registry=skill_registry,
            blocked_skill_names=None,
        )
        _enforce_report_synthesis_tool_preference(
            steps=plan.steps,
            available_tool_names=available_tool_names,
            session_id=state["session_id"],
            selected_skill_name=str(selected_skill.get("id") or selected_skill.get("name") or "").strip()
            if isinstance(selected_skill, dict)
            else None,
        )
        _enforce_file_io_write_params(
            steps=plan.steps,
            available_tool_names=available_tool_names,
            session_id=state["session_id"],
            selected_skill_name=str(selected_skill.get("id") or selected_skill.get("name") or "").strip()
            if isinstance(selected_skill, dict)
            else None,
        )
        injected_hybrid_runner_step = False
        if skill_md_prompt_injected:
            _drop_skill_read_steps(plan, state["session_id"])
        else:
            _normalize_skill_read_step_order(
                plan=plan,
                session_id=state["session_id"],
            )
        forced_execution_step = False
        if _is_explicit_skill_execution_request(user_text, selected_skill):
            forced_execution_step = _inject_minimum_execution_step(
                plan=plan,
                available_tool_names=available_tool_names,
                user_text=user_text,
                session_id=state["session_id"],
            )
        installer_gate = _enforce_structured_installer_gap(
            plan=plan,
            available_tool_names=available_tool_names,
            session_id=state["session_id"],
        )
        orchestration_trace = {
            "selected_skill": str(selected_skill.get("id") or selected_skill.get("name") or "") if isinstance(selected_skill, dict) else "",
            "has_skill_md": _has_skill_md_in_item(selected_skill) if isinstance(selected_skill, dict) else False,
            "skill_md_prompt_injected": bool(skill_md_prompt_injected),
            "preplan_generated": preplan_generated,
            "preview_prompt_dump_path": preview_prompt_dump_path,
            "final_prompt_dump_path": final_prompt_dump_path,
            "minimum_execution_step_injected": forced_execution_step,
            "hybrid_skill_script_runner_step_injected": injected_hybrid_runner_step,
            "installer_gate": installer_gate,
        }
        if event_emitter:
            await event_emitter.emit("skill_orchestration_trace", orchestration_trace)

        # Emit plan version event (initial + each replan)
        if event_emitter and plan.steps:
            await event_emitter.emit(
                "plan_version",
                {
                    "version": int(state.get("iteration", 0)) + 1,
                    "is_replan": int(state.get("iteration", 0)) > 0,
                    "phase": "final",
                    "goal": str(plan.goal or ""),
                    "steps": [
                        {
                            "id": step.id,
                            "title": step.title,
                            "tool": step.tool,
                            "parallel": bool(step.parallel),
                        }
                        for step in plan.steps
                    ],
                },
            )

        # Check if this is a simple question (no tools needed)
        if not plan.steps:
            return {
                "plan": plan,
                "pending_actions": [],
                "current_step": "respond",
            }

        can_delegate = _delegation_available(runtime_context, plan)
        if plan.requires_delegation and not can_delegate:
            logger.warning(
                "Delegation requested by planner but unavailable; falling back to local execution",
                extra={
                    "session_id": state["session_id"],
                    "delegate_to": plan.delegate_to,
                },
            )

        return {
            "plan": plan,
            "pending_actions": plan.steps,
            "metadata": {
                **(state.get("metadata") or {}),
                "skill_orchestration_trace": orchestration_trace,
            },
            "current_step": "delegate" if can_delegate else "act",
        }

    except Exception as e:
        error_text = _format_planning_error(e)
        logger.exception("Planning failed", extra={"error": error_text})
        return {
            "error": f"Planning failed: {error_text}",
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
    runtime_context = state.get("context")
    pending_actions, rewritten_count = _rewrite_unexecutable_pending_actions(
        pending_actions=pending_actions,
        runtime_context=runtime_context,
        unified_executor=unified_executor,
        session_id=state["session_id"],
    )
    if rewritten_count and event_emitter:
        await event_emitter.emit("pending_actions_sanitized", {"rewritten": rewritten_count})

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

    executed_sequential_actions = 0
    successful_sequential_actions = 0
    remaining_sequential_actions: list[PlanStep] = []

    for idx, action in enumerate(sequential_actions):
        executed_sequential_actions += 1
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
            elif action.tool == "skill_script_runner" and results:
                _inject_skill_script_artifacts(action, results, state["session_id"])

            result = await _execute_with_events(unified_executor, action, event_emitter)
            results.append(result)
            if result.success:
                successful_sequential_actions += 1
                continue

            remaining_sequential_actions = sequential_actions[idx + 1 :]
            logger.info(
                "sequential_execution_stopped_after_failure",
                extra={
                    "session_id": state["session_id"],
                    "failed_tool": action.tool,
                    "failed_step_id": action.id,
                    "remaining_actions": len(remaining_sequential_actions),
                },
            )
            break
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
            remaining_sequential_actions = sequential_actions[idx + 1 :]
            logger.info(
                "sequential_execution_stopped_after_exception",
                extra={
                    "session_id": state["session_id"],
                    "failed_tool": action.tool,
                    "failed_step_id": action.id,
                    "remaining_actions": len(remaining_sequential_actions),
                },
            )
            break

    # Advance current_step_index by the number of actions actually executed.
    plan = state.get("plan")
    updated_plan = None
    if plan and plan.steps:
        successful_parallel_actions = len(
            [row for row in results[: len(parallel_actions)] if getattr(row, "success", False)]
        )
        successful_count = successful_parallel_actions + successful_sequential_actions
        current_idx = int(getattr(plan, "current_step_index", 0) or 0)
        if successful_count > 0:
            next_idx = min(len(plan.steps) - 1, current_idx + successful_count - 1)
        else:
            next_idx = current_idx
        updated_plan = ExecutionPlan(
            goal=plan.goal,
            steps=plan.steps,
            current_step_index=next_idx,
            requires_delegation=plan.requires_delegation,
            delegate_to=plan.delegate_to,
        )

    result_state = {
        "tool_results": results,
        "pending_actions": remaining_sequential_actions,
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

    if not plan:
        return {
            "error": "Delegation not configured or no target specified",
            "current_step": "observe",
        }

    if not delegator or not plan.delegate_to:
        logger.warning(
            "Delegation unavailable; requesting replan with local tools",
            extra={
                "session_id": state["session_id"],
                "delegate_to": plan.delegate_to,
                "delegator_configured": bool(delegator),
            },
        )
        guidance = Message(
            role="user",
            content=(
                "[SYSTEM] Delegation is unavailable in this runtime. "
                "Please replan and execute using only available local tools/MCP/skills. "
                "Do NOT set requires_delegation=true."
            ),
            name=None,
            tool_call_id=None,
        )
        failed_result = ToolCallResult(
            tool_name=f"subagent:{plan.delegate_to or 'unknown'}",
            params={"task": plan.goal},
            error="Delegation unavailable in current runtime",
            success=False,
        )
        return {
            "messages": [guidance],
            "tool_results": [failed_result],
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

    runtime_context = state.get("context")

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
            "observe_outcome": "task_completed",
        }

    # Analyze results
    tool_results = state["tool_results"]
    has_errors = any(
        not (bool(r.get("success")) if isinstance(r, dict) else bool(r.success))
        for r in tool_results
    )
    all_failed = (
        all(
            not (bool(r.get("success")) if isinstance(r, dict) else bool(r.success))
            for r in tool_results
        )
        if tool_results
        else False
    )

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
            "observe_outcome": "replan_current_round",
        }

    # If there are recoverable deterministic errors, force one replan path.
    if (
        has_errors
        and current_iteration < MAX_REPLAN_ATTEMPTS
        and _has_recoverable_replan_error(tool_results)
    ):
        error_summaries: list[str] = []
        for r in tool_results:
            success = bool(r.get("success")) if isinstance(r, dict) else bool(r.success)
            if success:
                continue
            tool_name = str(r.get("tool_name") or "unknown") if isinstance(r, dict) else str(r.tool_name or "unknown")
            error_text = _tool_result_error_text(r)
            if error_text:
                error_summaries.append(f"- {tool_name}: {error_text}")

        logger.info(
            "replan_recoverable_error",
            extra={
                "session_id": state["session_id"],
                "error_count": len(error_summaries),
                "iteration": current_iteration,
            },
        )
        context_msg = Message(
            role="user",
            content=(
                "[SYSTEM] REPLAN — deterministic recoverable errors detected in executed steps.\n"
                "Please generate an alternative plan that avoids repeating the same invalid parameters.\n\n"
                "Detected errors:\n"
                + ("\n".join(error_summaries) if error_summaries else "- unknown error")
                + "\n\nGuidance:\n"
                "- If rule creation fails due to name conflict, generate a unique rule name/id.\n"
                "- For cron + notify actions, ensure params.gateway_id is set from current gateway context.\n"
                "- Use action_mode from {ask,suggest,auto,skip}; default to auto unless user explicitly asks otherwise."
            ),
            name=None,
            tool_call_id=None,
        )
        return {
            "iteration": current_iteration,
            "messages": [context_msg],
            "current_step": "plan",
            "observe_outcome": "replan_current_round",
        }

    # Check if there are more pending steps in the plan
    plan = state["plan"]
    if plan and plan.steps and plan.current_step_index < len(plan.steps) - 1:
        successful_results = [
            r
            for r in tool_results
            if (bool(r.get("success")) if isinstance(r, dict) else bool(r.success))
            and (r.get("result") if isinstance(r, dict) else r.result)
        ]
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
                    payload = r.get("result") if isinstance(r, dict) else r.result
                    tool_name = str(r.get("tool_name") or "unknown") if isinstance(r, dict) else str(r.tool_name or "unknown")
                    result_str = payload if isinstance(payload, str) else str(payload)
                    if len(result_str) > REPLAN_RESULT_MAX_CHARS:
                        result_str = result_str[:REPLAN_RESULT_MAX_CHARS] + "...(truncated)"
                    results_summary.append(f"[{tool_name}] result:\n{result_str}")

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
                        f"- You may decide to re-run a completed tool if you judge the result "
                        f"was insufficient, but avoid unnecessary repetition.\n"
                        + (
                            (
                                f"- Keep the current round within the selected skill '{current_skill_name}'.\n"
                                f"- Re-read and follow that skill's SKILL.md for replanning.\n"
                                f"- Do NOT substitute the skill's phases with generic code_executor/file_io/pdf steps unless the skill explicitly instructs that.\n"
                            )
                            if current_skill_name
                            else (
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
                            )
                        )
                        + f"- Overall goal: {plan.goal}"
                    ),
                    name=None,
                    tool_call_id=None,
                )
                return {
                    "iteration": current_iteration,
                    "messages": [context_msg],
                    "current_step": "plan",
                    "observe_outcome": "replan_current_round",
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
                    "observe_outcome": "task_completed",
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
            "observe_outcome": "continue_execution",
        }

    latest_user_text = ""
    for message in reversed(state.get("messages", [])):
        if str(message.get("role") or "") == "user":
            latest_user_text = str(message.get("content") or "")
            break

    metadata = state.get("metadata") or {}
    trace = metadata.get("skill_orchestration_trace") if isinstance(metadata, dict) else None
    current_skill_name = str((trace or {}).get("selected_skill") or "").strip() if isinstance(trace, dict) else ""
    followup_skill = _pick_followup_skill_candidate(runtime_context, latest_user_text, current_skill_name)
    handoff_artifacts = _has_handoff_artifacts(tool_results)

    if followup_skill and handoff_artifacts and current_iteration < max_iterations:
        artifact_lines = "\n".join(f"- {path}" for path in handoff_artifacts[:10])
        followup_name = str(followup_skill.get("id") or followup_skill.get("name") or "").strip()
        next_round_msg = Message(
            role="user",
            content=(
                "[SYSTEM] NEXT ROUND — current round completed successfully.\n"
                f"Start the next round using skill '{followup_name}'.\n"
                "Consume the following handoff artifacts from the previous round:\n"
                f"{artifact_lines}\n\n"
                "Requirements:\n"
                "- Re-run skill selection for this new round.\n"
                "- Re-inject the selected skill's SKILL.md.\n"
                "- Treat the previous round artifacts as formal inputs.\n"
                "- Do not continue the previous round plan."
            ),
            name=None,
            tool_call_id=None,
        )
        return {
            "iteration": current_iteration,
            "messages": [next_round_msg],
            "current_step": "plan",
            "observe_outcome": "plan_next_round",
        }

    # All steps completed, move to reflection
    return {
        "iteration": current_iteration,
        "current_step": "reflect",
        "observe_outcome": "task_completed",
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

    tool_results = state.get("tool_results", [])
    has_success_results = any(r.success for r in tool_results) if tool_results else False
    if has_success_results and _looks_like_premature_final_response(response_content):
        fallback_response = _build_tool_result_fallback_response(
            tool_results=tool_results,
            messages=state.get("messages", []),
        )
        if fallback_response and fallback_response != response_content:
            logger.warning(
                "premature_response_rewritten_with_fallback",
                extra={"session_id": state["session_id"]},
            )
            response_content = fallback_response
            if event_emitter:
                await event_emitter.emit_text_chunk(f"\n\n{fallback_response}")

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
