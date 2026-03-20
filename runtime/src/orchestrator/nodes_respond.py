"""Respond-domain helpers and RESPOND node implementation."""

from __future__ import annotations

from typing import Any

import re as _re

from src.orchestrator.nodes_shared import (
    _artifact_has_real_file,
    _artifact_has_real_text,
    _collect_visible_artifacts,
    _final_delivery_contract_fulfilled,
    _tool_result_error_text,
)
from src.orchestrator.respond_delivery import (
    _build_inline_delivery_fallback,
    _collect_delivery_payloads,
    _emit_delivery_file_messages,
    _extract_search_results,
    _filter_artifacts_for_delivery_step,
    _render_delivery_payloads,
    _render_inline_delivery_markdown,
    _resolve_delivery_step_id,
)
from src.orchestrator.state import (
    AgentState,
    ExecutionPlan,
    Message,
    ReflectionResult,
    ToolCallResult,
)
from src.utils.logging import get_logger

logger = get_logger(__name__)

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

_PROCESS_LEAK_PATTERNS = (
    "分析请求",
    "确定行动计划",
    "执行 - 读取技能",
    "执行-读取技能",
    "执行 - 进行研究",
    "执行-进行研究",
    "结果假设",
    "最终审查约束条件",
    "提示词构建",
    "模拟工具输出",
    "开始撰写",
    "我将按照要求进行格式化",
    "我将基于",
    "让我读取",
    "步骤1：读取",
    "步骤2：使用",
    "内部操作：读取",
)


def _infer_response_language(text: str) -> str:
    sample = str(text or "").strip()
    if any("\u4e00" <= ch <= "\u9fff" for ch in sample):
        return "zh"
    if any("\u3040" <= ch <= "\u30ff" for ch in sample):
        return "ja"
    return "en"


# Backward-compatible helper name for planner/act modules.
def _infer_delivery_language(text: str) -> str:
    return _infer_response_language(text)


def _latest_non_system_user_text_from_messages(messages: list[dict[str, Any]] | list[Any]) -> str:
    for message in reversed(messages or []):
        role = str(message.get("role") if isinstance(message, dict) else getattr(message, "role", ""))
        if role != "user":
            continue
        content = str(message.get("content") if isinstance(message, dict) else getattr(message, "content", ""))
        if content and not content.startswith("[SYSTEM]"):
            return content
    return ""


def _build_sparse_success_fallback(query: str) -> str:
    title = str(query or "").strip() or "当前请求"
    return (
        f"已完成对“{title}”的处理。"
        "\n当前执行结果中缺少可提炼的结构化内容。请重试并补充更具体的研究维度（如财务、估值、竞争格局）。"
    )


def _looks_like_premature_final_response(text: str) -> bool:
    content = (text or "").strip()
    if not content:
        return True
    lower = content.lower()
    process_hits = sum(1 for token in _PROCESS_LEAK_PATTERNS if token in content or token.lower() in lower)
    if process_hits >= 2:
        return True
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
    return len(content) < 220 and not has_evidence


async def respond_node(state: AgentState, context: dict[str, Any]) -> dict[str, Any]:
    logger.info("Generating response", extra={"session_id": state["session_id"]})

    event_emitter = context.get("event_emitter")
    llm_provider = context.get("llm_provider")
    plan = state.get("plan")

    # Resolve act-role model config early so it can be used throughout the node
    _runtime_context = state.get("context")
    _act_model: str | None = None
    _act_temperature: float = 0.2
    if _runtime_context and getattr(_runtime_context, "agent_config", None):
        _role_cfg = _runtime_context.agent_config.model_roles.act
        _act_model = _role_cfg.model or _runtime_context.agent_config.model
        if _role_cfg.temperature is not None:
            _act_temperature = _role_cfg.temperature

    tool_results = state.get("tool_results", [])
    has_success_results = any(r.success for r in tool_results) if tool_results else False
    has_failed_results = any(not r.success for r in tool_results) if tool_results else False
    latest_structured_act_result = next(
        (
            result
            for result in reversed(tool_results)
            if isinstance(getattr(result, "metadata", None), dict)
            and (
                str(result.metadata.get("act_decision") or "").strip().lower()
                in {"continue_current_step", "advance_step", "complete_task"}
                or str(result.metadata.get("act_result_type") or "").strip().lower() in {"execution_result", "execution_blocked"}
            )
        ),
        None,
    )
    delivery_step_id = _resolve_delivery_step_id(
        state=state,
        latest_structured_act_result=latest_structured_act_result,
    )
    generated_file_response = None
    artifacts = _collect_visible_artifacts(tool_results)
    delivery_artifacts = _filter_artifacts_for_delivery_step(
        artifacts,
        source_step_id=delivery_step_id,
    )
    primary_artifact = (
        sorted(
            delivery_artifacts,
            key=lambda item: (
                0 if bool(item.get("is_likely_final")) else 1,
                0
                if str(item.get("artifact_medium") or "").strip().lower() == "text"
                and str(item.get("artifact_type") or "").strip().lower() == "research_report"
                else {
                    "report_md": 0,
                    "report_html": 1,
                    "report_pdf": 2,
                    "data_json": 5,
                    "file": 9,
                }.get(str(item.get("artifact_role") or "").strip().lower(), 9),
                str(item.get("artifact_name") or item.get("filename") or "").lower(),
            ),
        )[0]
        if delivery_artifacts
        else None
    )
    final_delivery_contract = (
        plan.final_delivery_contract
        if isinstance(plan, ExecutionPlan) and isinstance(plan.final_delivery_contract, dict)
        else {}
    )
    delivery_title = str(
        final_delivery_contract.get("delivery_goal")
        or _latest_non_system_user_text_from_messages(state.get("messages", []))
        or "当前请求"
    ).strip()
    response_language = _infer_response_language(
        _latest_non_system_user_text_from_messages(state.get("messages", [])) or delivery_title
    )
    preferred_text_delivery_artifact = next(
        (
            item
            for item in delivery_artifacts
            if str(item.get("artifact_medium") or "").strip().lower() == "text"
            and str(item.get("artifact_result_text") or "").strip()
        ),
        None,
    )
    delivery_fulfilled, delivery_reason = _final_delivery_contract_fulfilled(
        final_delivery_contract=final_delivery_contract,
        artifacts=artifacts,
        latest_structured_act_result=latest_structured_act_result,
        execution_state=state.get("execution_state"),
    )
    real_artifact_labels = [
        str(
            item.get("filename")
            or item.get("artifact_name")
            or item.get("artifact_result_path")
            or ""
        ).strip()
        for item in delivery_artifacts
        if _artifact_has_real_file(item) or _artifact_has_real_text(item)
    ]
    real_artifact_labels = [item for item in real_artifact_labels if item]
    delivery_payloads = _collect_delivery_payloads(
        delivery_artifacts,
        latest_structured_act_result=latest_structured_act_result,
        source_step_id=delivery_step_id,
    )
    inline_delivery_items: list[dict[str, str]] = []
    if isinstance(preferred_text_delivery_artifact, dict):
        text_value = str(preferred_text_delivery_artifact.get("artifact_result_text") or "").strip()
        if text_value:
            chunks = [line.strip("- ").strip() for line in text_value.splitlines() if line.strip()]
            for idx, line in enumerate(chunks[:6], start=1):
                inline_delivery_items.append({"title": f"Item {idx}", "summary": line})
    if not inline_delivery_items and latest_structured_act_result is not None and isinstance(getattr(latest_structured_act_result, "metadata", None), dict):
        act_metadata = latest_structured_act_result.metadata or {}
        observations = act_metadata.get("act_observations")
        if isinstance(observations, list):
            for idx, item in enumerate(observations[:6], start=1):
                if not isinstance(item, dict):
                    continue
                summary = str(item.get("summary") or "").strip()
                if summary:
                    inline_delivery_items.append(
                        {
                            "title": str(item.get("step_id") or f"Item {idx}").strip() or f"Item {idx}",
                            "summary": summary,
                        }
                    )
    if not inline_delivery_items:
        search_rows = _extract_search_results([row for row in tool_results if row.success])
        for idx, item in enumerate(search_rows[:6], start=1):
            if not isinstance(item, dict):
                continue
            inline_delivery_items.append(
                {
                    "title": str(item.get("title") or item.get("name") or f"Item {idx}").strip(),
                    "url": str(item.get("url") or "").strip(),
                    "summary": str(item.get("snippet") or item.get("content") or "").strip(),
                }
            )
    if isinstance(primary_artifact, dict):
        if str(primary_artifact.get("artifact_medium") or "").strip().lower() == "text":
            if str(primary_artifact.get("artifact_type") or "").strip().lower() == "research_report":
                generated_file_response = "已生成主研究报告文本。HTML/PDF 如有需要，应基于该主报告派生。"
            else:
                text_name = str(primary_artifact.get("artifact_name") or "文本结果").strip() or "文本结果"
                generated_file_response = f"已生成文本结果：{text_name}。"
        else:
            primary_name = str(
                primary_artifact.get("filename") or primary_artifact.get("artifact_name") or ""
            ).strip()
            if primary_name:
                role = str(primary_artifact.get("artifact_role") or "").strip().lower()
                if role == "report_md":
                    generated_file_response = f"已生成主报告文件：{primary_name}。HTML/PDF 如有需要，应基于该 Markdown 报告派生。"
                elif role == "report_html":
                    generated_file_response = f"已生成 HTML 报告文件：{primary_name}。其主源内容应来自 Markdown 报告。"
                elif role == "report_pdf":
                    generated_file_response = f"已生成 PDF 报告文件：{primary_name}。如需继续校验或改写，请优先使用对应的 Markdown 主报告。"
                else:
                    generated_file_response = f"已生成文件：{primary_name}。"
    approval_ids: list[str] = []
    for result in tool_results:
        meta = getattr(result, "metadata", None)
        if not isinstance(meta, dict):
            continue
        status = str(meta.get("approval_status") or "").strip().lower()
        approval_id = str(meta.get("approval_id") or "").strip()
        if status == "pending" and approval_id:
            approval_ids.append(approval_id)
    pending_approval_ids = list(dict.fromkeys(approval_ids))
    if not pending_approval_ids:
        pending_approval_ids = [
            str(item).strip()
            for item in (state.get("metadata") or {}).get("pending_approval_ids", [])
            if str(item).strip()
        ]
    if pending_approval_ids:
        response_content = (
            "操作需要人工审批后继续。\n\n"
            f"待审批 ID: {', '.join(pending_approval_ids)}\n"
            "请在审批面板中通过或拒绝后继续。"
        )
        if event_emitter:
            await event_emitter.emit_text_chunk(response_content)
        return {"messages": [Message(role="assistant", content=response_content, name=None, tool_call_id=None)]}
    if plan and getattr(plan, "plan_type", "plan") == "terminate" and (
        str(getattr(plan, "user_reply", "") or "").strip()
        or str(getattr(plan, "summary_for_act", "") or "").strip()
        or str(getattr(plan, "terminate_reason", "") or "").strip()
    ):
        response_content = (
            str(getattr(plan, "user_reply") or "").strip()
            or str(getattr(plan, "summary_for_act") or "").strip()
            or str(getattr(plan, "terminate_reason") or "").strip()
        )
        if event_emitter:
            await event_emitter.emit_text_chunk(response_content)
        return {"messages": [Message(role="assistant", content=response_content, name=None, tool_call_id=None)]}
    latest_delegate_result = next(
        (
            result
            for result in reversed(tool_results)
            if result.success and isinstance(getattr(result, "metadata", None), dict) and bool(result.metadata.get("delegate"))
        ),
        None,
    )
    if latest_delegate_result is not None:
        delegate_meta = latest_delegate_result.metadata or {}
        sub_agent_id = str(delegate_meta.get("sub_agent_id") or latest_delegate_result.tool_name or "").strip()
        delegated_text = str(latest_delegate_result.result or "").strip()
        response_lines = [f"子代理 {sub_agent_id or 'sub-agent'} 已完成委派任务。"]
        if delegated_text:
            response_lines.append(delegated_text)
        expected_outputs = [
            str(item or "").strip()
            for item in (delegate_meta.get("expected_outputs") or [])
            if str(item or "").strip()
        ]
        if expected_outputs:
            response_lines.append("预期输出：")
            response_lines.extend(f"- {item}" for item in expected_outputs[:8])
        response_content = "\n".join(response_lines).strip()
        if event_emitter:
            await event_emitter.emit_text_chunk(response_content)
        return {"messages": [Message(role="assistant", content=response_content, name=None, tool_call_id=None)]}
    if not delivery_fulfilled and state.get("observe_outcome") == "task_completed":
        response_content = (
            "执行已完成，但尚未生成可交付的 artifact_result_* 内容。"
            if response_language == "zh"
            else "Execution completed, but no deliverable artifact_result_* payload was produced."
        )
        if delivery_reason:
            response_content = f"{response_content}\n{delivery_reason}"
        if event_emitter:
            await event_emitter.emit_text_chunk(response_content)
        return {"messages": [Message(role="assistant", content=response_content, name=None, tool_call_id=None)]}
    if delivery_payloads:
        response_content = _render_delivery_payloads(delivery_payloads)
        if response_content:
            await _emit_delivery_file_messages(
                event_emitter=event_emitter,
                tool_results=tool_results,
                delivery_artifacts=delivery_artifacts,
            )
            if event_emitter:
                await event_emitter.emit_text_chunk(response_content)
            return {"messages": [Message(role="assistant", content=response_content, name=None, tool_call_id=None)]}
    if generated_file_response:
        if event_emitter:
            await event_emitter.emit_text_chunk(generated_file_response)
        return {"messages": [Message(role="assistant", content=generated_file_response, name=None, tool_call_id=None)]}
    if latest_structured_act_result is not None:
        act_metadata = latest_structured_act_result.metadata or {}
        observe_outcome = str(state.get("metadata", {}).get("observe_outcome") or "").strip().lower()
        act_decision = str(act_metadata.get("act_decision") or "").strip().lower()
        observations = act_metadata.get("act_observations") if isinstance(act_metadata.get("act_observations"), list) else []
        artifacts_produced = [str(item or "").strip() for item in (act_metadata.get("act_artifacts_produced") or []) if str(item or "").strip()]
        lines: list[str] = []
        if observe_outcome == "task_completed" or act_decision in {"complete_task", "advance_step"}:
            lines.append("任务已完成。")
        elif observe_outcome == "continue_execution" or act_decision == "continue_current_step":
            lines.append("当前 step 仍在继续。")
        else:
            lines.append("当前轮执行已完成。")
        for item in observations[:6]:
            if not isinstance(item, dict):
                continue
            summary = str(item.get("summary") or "").strip()
            if summary:
                lines.append(f"- {summary}")
        if real_artifact_labels:
            lines.append("已产出：")
            lines.extend(f"- {item}" for item in real_artifact_labels[:8])
        response_content = "\n".join(lines).strip()
        if response_content:
            if event_emitter:
                await event_emitter.emit_text_chunk(response_content)
            return {"messages": [Message(role="assistant", content=response_content, name=None, tool_call_id=None)]}
    reflection = state.get("reflection")
    if isinstance(reflection, ReflectionResult) and str(reflection.summary or "").strip():
        response_content = str(reflection.summary).strip()
        if event_emitter:
            await event_emitter.emit_text_chunk(response_content)
        return {"messages": [Message(role="assistant", content=response_content, name=None, tool_call_id=None)]}
    error_text = str(state.get("error") or "").strip()
    if error_text:
        error_message = Message(
            role="assistant",
            content=f"I encountered an error: {error_text}. Please try again.",
            name=None,
            tool_call_id=None,
        )
        if event_emitter:
            await event_emitter.emit_text_chunk(error_message["content"])
        return {"messages": [error_message]}
    if has_failed_results:
        query = _latest_non_system_user_text_from_messages(state.get("messages", []))
        title = query.strip() or "当前请求"
        failed_rows = [row for row in tool_results if not row.success]
        lines = [f"未能完成“{title}”。", "本次失败基于实际执行结果，已观测到的问题如下："]
        if not failed_rows:
            lines.append("- 未记录到可用的失败详情。")
        else:
            for row in failed_rows[:6]:
                tool_name = str(row.tool_name or "unknown")
                error_text = _tool_result_error_text(row) or "unknown error"
                lines.append(f"- {tool_name}: {error_text}")
        lines.append("请根据以上实际错误重试；当前回复不对失败原因做额外推断。")
        response_content = "\n".join(lines)
        if event_emitter:
            await event_emitter.emit_text_chunk(response_content)
        return {"messages": [Message(role="assistant", content=response_content, name=None, tool_call_id=None)]}
    if has_success_results and inline_delivery_items:
        response_content = (
            await _render_inline_delivery_markdown(
                llm_provider=llm_provider,
                title=delivery_title,
                source_items=inline_delivery_items,
                language=response_language,
                model=_act_model,
                temperature=_act_temperature,
            )
            or _build_inline_delivery_fallback(
                title=delivery_title,
                source_items=inline_delivery_items,
                language=response_language,
            )
        )
        if event_emitter:
            await event_emitter.emit_text_chunk(response_content)
        return {"messages": [Message(role="assistant", content=response_content, name=None, tool_call_id=None)]}
    execution_state = state.get("execution_state") if isinstance(state.get("execution_state"), dict) else {}
    completed_steps = [str(item or "").strip() for item in (execution_state.get("completed_steps") or []) if str(item or "").strip()]
    observations = [str(item or "").strip() for item in (execution_state.get("observations") or []) if str(item or "").strip()]
    artifacts_produced = [str(item or "").strip() for item in (execution_state.get("artifacts_produced") or []) if str(item or "").strip()]
    unresolved_questions = [str(item or "").strip() for item in (execution_state.get("unresolved_questions") or []) if str(item or "").strip()]
    if completed_steps or observations or artifacts_produced:
        lines = ["已完成当前任务流程。"]
        if completed_steps:
            lines.append(f"已完成步骤：{', '.join(completed_steps[:8])}")
        if observations:
            lines.append("执行观察：")
            lines.extend(f"- {item}" for item in observations[:6])
        if real_artifact_labels:
            lines.append("已产出：")
            lines.extend(f"- {item}" for item in real_artifact_labels[:8])
        if unresolved_questions:
            lines.append("未解决项：")
            lines.extend(f"- {item}" for item in unresolved_questions[:6])
        response_content = "\n".join(lines).strip()
        if event_emitter:
            await event_emitter.emit_text_chunk(response_content)
        return {"messages": [Message(role="assistant", content=response_content, name=None, tool_call_id=None)]}
    response_content = "任务已完成。"
    if llm_provider:
        try:
            agent_system_prompt = ""
            agent_model = _act_model
            respond_temperature = _act_temperature
            runtime_context = _runtime_context
            if runtime_context and runtime_context.agent_config:
                agent_system_prompt = runtime_context.agent_config.system_prompt or ""
            memory_ctx = state.get("memory_context", "")
            memory_snapshot = state.get("memory_snapshot", {})
            memory_system = context.get("memory_system")
            if memory_system and hasattr(memory_system, "render_memory_snapshot"):
                try:
                    memory_ctx = memory_system.prepare_memory_context(
                        memory_system.render_memory_snapshot(memory_snapshot),
                        max_chars=4000,
                    )
                except Exception:
                    memory_ctx = str(memory_ctx or "")
            elif memory_system and hasattr(memory_system, "prepare_memory_context"):
                try:
                    memory_ctx = memory_system.prepare_memory_context(
                        str(memory_ctx or ""),
                        max_chars=4000,
                    )
                except Exception:
                    memory_ctx = str(memory_ctx or "")
            if event_emitter and hasattr(llm_provider, "generate_response_stream"):
                chunks = []
                async for chunk in llm_provider.generate_response_stream(
                    messages=state["messages"],
                    results=state["tool_results"],
                    reflection=state.get("reflection"),
                    agent_system_prompt=agent_system_prompt,
                    model=agent_model,
                    memory_context=memory_ctx,
                    temperature=respond_temperature,
                ):
                    chunks.append(chunk)
                response_content = "".join(chunks)
            else:
                response_content = await llm_provider.generate_response(
                    messages=state["messages"],
                    results=state["tool_results"],
                    reflection=state.get("reflection"),
                    agent_system_prompt=agent_system_prompt,
                    model=agent_model,
                    memory_context=memory_ctx,
                    temperature=respond_temperature,
                )
        except Exception as e:
            logger.error(f"Response generation failed: {e}")
            response_content = "I completed the task but encountered an issue generating the response. Please try again."
    unexecuted_tool_call_markers = (
        "<function_calls>",
        "</function_calls>",
        "<invoke name=",
        "<parameter name=",
        "tool_code",
        "read_file",
        ".kimi/skills/",
    )
    if str(response_content or "").strip() and any(
        marker in response_content or marker in response_content.lower()
        for marker in unexecuted_tool_call_markers
    ):
        logger.warning("unexecuted_tool_call_response_blocked", extra={"session_id": state["session_id"]})
        if has_success_results:
            if inline_delivery_items:
                fallback_response = _build_inline_delivery_fallback(
                    title=delivery_title,
                    source_items=inline_delivery_items,
                    language=response_language,
                )
            else:
                fallback_response = _build_sparse_success_fallback(delivery_title)
            response_content = fallback_response or "执行未完成：最终响应中出现了未执行的工具调用文本，当前结果无效，请重试。"
        else:
            response_content = "执行未完成：模型输出了未执行的工具调用文本，当前结果无效，请重试。"
    if has_success_results and _looks_like_premature_final_response(response_content):
        if inline_delivery_items:
            fallback_response = _build_inline_delivery_fallback(
                title=delivery_title,
                source_items=inline_delivery_items,
                language=response_language,
            )
        else:
            fallback_response = _build_sparse_success_fallback(delivery_title)
        if fallback_response and fallback_response != response_content:
            logger.warning("premature_response_rewritten_with_fallback", extra={"session_id": state["session_id"]})
            response_content = fallback_response
    if not str(response_content or "").strip():
        query = _latest_non_system_user_text_from_messages(state.get("messages", []))
        response_content = _build_sparse_success_fallback(query) if has_success_results else "任务已完成。"
    if event_emitter:
        await event_emitter.emit_text_chunk(response_content)
    response_message = Message(role="assistant", content=response_content, name=None, tool_call_id=None)
    memory_system = context.get("memory_system")
    if memory_system:
        try:
            user_message = state["messages"][-1]["content"] if state["messages"] else ""
            runtime_context = state.get("context")
            runtime_context_metadata = getattr(runtime_context, "metadata", None)
            runtime_org_id = None
            if isinstance(runtime_context_metadata, dict):
                raw_org_id = runtime_context_metadata.get("org_id")
                if isinstance(raw_org_id, str):
                    runtime_org_id = raw_org_id.strip() or None
            if user_message:
                await memory_system.append_short_term(
                    session_id=state["session_id"],
                    content=f"[user] {user_message}",
                )
            if response_content:
                await memory_system.append_short_term(
                    session_id=state["session_id"],
                    content=f"[assistant] {response_content}",
                )
            if hasattr(memory_system, "maybe_auto_consolidate"):
                await memory_system.maybe_auto_consolidate(
                    session_id=state["session_id"],
                    agent_id=state["agent_id"],
                    org_id=runtime_org_id,
                    latest_user_message=str(user_message or ""),
                    latest_assistant_message=str(response_content or ""),
                )
        except Exception as e:
            logger.warning(f"Failed to save short-term memory: {e}")
    return {"messages": [response_message]}
