"""Tests for memory system integration in orchestrator nodes.

Covers:
- start_node: short-term/long-term memory loading, graceful degradation, error handling
- reflect_node: long-term memory storage based on worth_remembering, degradation
- respond_node: short-term memory saving for user/assistant messages, degradation
"""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from src.orchestrator.nodes_reflect import reflect_node
from src.orchestrator.nodes_respond import respond_node
from src.orchestrator.nodes_start import start_node
from src.orchestrator.state import (
    ExecutionPlan,
    Message,
    PlanStep,
    ReflectionResult,
    ToolCallResult,
)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture
def memory_system():
    """Create a mock MemorySystem with short-term and long-term backends."""
    ms = AsyncMock()
    ms.get_short_term = AsyncMock(return_value="")
    ms.search_long_term = AsyncMock(return_value="")
    ms.build_memory_context = AsyncMock(
        return_value={
            "memory_context": "",
            "short_term": "",
            "long_term_results": [],
            "budget": {
                "used_chars": 0,
                "budget_chars": 12000,
                "remaining_chars": 12000,
                "remaining_ratio": 1.0,
                "remaining_percent": 100,
            },
        }
    )
    ms.append_short_term = AsyncMock()
    ms.save_long_term = AsyncMock(return_value="mem_id_1")
    ms.render_memory_snapshot = MagicMock(side_effect=lambda snapshot: str((snapshot or {}).get("short_term") or (snapshot or {}).get("memory_context") or ""))
    ms.prepare_memory_context = MagicMock(side_effect=lambda value, max_chars: str(value or "")[:max_chars])
    ms.prepare_memory_context_for_plan = MagicMock(side_effect=lambda value, max_chars: str(value or "")[:max_chars])
    ms.format_short_term_budget_prompt = AsyncMock(
        return_value=(
            "Current short-term memory budget:\n"
            "- used_chars=0\n"
            "- budget_chars=12000\n"
            "- remaining_percent=100\n\n"
        )
    )
    ms.maybe_auto_consolidate = AsyncMock(
        return_value={
            "consolidated": False,
            "short_term_compacted": False,
            "long_term_written": 0,
        }
    )
    return ms


@pytest.fixture
def base_state():
    """Minimal AgentState dict for testing."""
    return {
        "session_id": "sess_001",
        "agent_id": "agent_001",
        "user_id": "user_001",
        "context": SimpleNamespace(agent_config=None, metadata={"org_id": "org_001"}),
        "messages": [
            Message(role="user", content="你好，帮我搜索AI新闻", name=None, tool_call_id=None),
        ],
        "current_step": "start",
        "plan": None,
        "pending_actions": [],
        "tool_results": [],
        "memory_context": "",
        "memory_snapshot": {
            "memory_context": "",
            "short_term": "",
            "long_term_results": [],
            "budget": {
                "used_chars": 0,
                "budget_chars": 12000,
                "remaining_chars": 12000,
                "remaining_ratio": 1.0,
                "remaining_percent": 100,
            },
        },
        "reflection": None,
        "iteration": 0,
        "error": None,
        "metadata": {},
        "evolved_skill_refs": [],
        "evolution_triggered": False,
    }


# ===========================================================================
# start_node — memory loading
# ===========================================================================

class TestStartNodeMemory:
    """Tests for memory loading in start_node."""

    @pytest.mark.asyncio
    async def test_loads_short_and_long_term(self, base_state, memory_system):
        """start_node should load both short-term and long-term memory."""
        memory_system.build_memory_context.return_value = {
            "memory_context": "Recent context:\n[user] 之前的对话内容\n\nRelevant knowledge:\n用户偏好：中文回复",
            "short_term": "[user] 之前的对话内容",
            "long_term_results": [{"content": "用户偏好：中文回复"}],
            "budget": {"used_chars": 10, "budget_chars": 100, "remaining_chars": 90, "remaining_ratio": 0.9, "remaining_percent": 90},
        }

        ctx = {"memory_system": memory_system}
        result = await start_node(base_state, ctx)

        memory_system.build_memory_context.assert_awaited_once_with(
            session_id="sess_001",
            agent_id="agent_001",
            query="你好，帮我搜索AI新闻",
            org_id="org_001",
            long_term_limit=5,
        )
        assert "Recent context:" in result["memory_context"]
        assert "Relevant knowledge:" in result["memory_context"]
        assert result["memory_snapshot"]["short_term"] == "[user] 之前的对话内容"
        assert result["memory_snapshot"]["long_term_results"] == [{"content": "用户偏好：中文回复"}]
        assert result["current_step"] == "plan"

    @pytest.mark.asyncio
    async def test_loads_short_term_only(self, base_state, memory_system):
        """When long-term returns empty, only short-term appears."""
        memory_system.build_memory_context.return_value = {
            "memory_context": "Recent context:\n[user] 历史消息",
            "short_term": "[user] 历史消息",
            "long_term_results": [],
            "budget": {},
        }

        ctx = {"memory_system": memory_system}
        result = await start_node(base_state, ctx)

        assert "Recent context:" in result["memory_context"]
        assert "Relevant knowledge:" not in result["memory_context"]
        assert result["memory_snapshot"]["short_term"] == "[user] 历史消息"

    @pytest.mark.asyncio
    async def test_loads_long_term_only(self, base_state, memory_system):
        """When short-term returns empty, only long-term appears."""
        memory_system.build_memory_context.return_value = {
            "memory_context": "Relevant knowledge:\n用户偏好：Celsius",
            "short_term": "",
            "long_term_results": [{"content": "用户偏好：Celsius"}],
            "budget": {},
        }

        ctx = {"memory_system": memory_system}
        result = await start_node(base_state, ctx)

        assert "Recent context:" not in result["memory_context"]
        assert "Relevant knowledge:" in result["memory_context"]
        assert result["memory_snapshot"]["long_term_results"] == [{"content": "用户偏好：Celsius"}]

    @pytest.mark.asyncio
    async def test_no_memory_system(self, base_state):
        """Without memory_system in context, memory_context should be empty."""
        ctx = {}
        result = await start_node(base_state, ctx)

        assert result["memory_context"] == ""
        assert result["memory_snapshot"]["budget"]["budget_chars"] == 12000
        assert result["current_step"] == "plan"

    @pytest.mark.asyncio
    async def test_memory_exception_is_swallowed(self, base_state, memory_system):
        """Memory errors should be caught — start_node must not crash."""
        memory_system.build_memory_context.side_effect = ConnectionError("memory down")

        ctx = {"memory_system": memory_system}
        result = await start_node(base_state, ctx)

        # Should degrade gracefully
        assert result["memory_context"] == ""
        assert result["memory_snapshot"]["memory_context"] == ""
        assert result["current_step"] == "plan"

    @pytest.mark.asyncio
    async def test_empty_messages(self, base_state, memory_system):
        """When messages list is empty, long-term query should use empty string."""
        base_state["messages"] = []

        ctx = {"memory_system": memory_system}
        await start_node(base_state, ctx)

        memory_system.build_memory_context.assert_awaited_once_with(
            session_id="sess_001",
            agent_id="agent_001",
            query="",
            org_id="org_001",
            long_term_limit=5,
        )


# ===========================================================================
# reflect_node — long-term memory storage
# ===========================================================================

class TestReflectNodeMemory:
    """Tests for long-term memory storage in reflect_node."""

    def _make_reflect_state(self, base_state):
        """Add plan and tool_results needed by reflect_node."""
        base_state["plan"] = ExecutionPlan(
            goal="搜索AI新闻",
            steps=[PlanStep(id="1", title="search", tool="tavily-search", params={})],
            current_step_index=1,
        )
        base_state["tool_results"] = [
            ToolCallResult(
                tool_name="tavily-search",
                params={"query": "AI news"},
                result="Found 5 articles",
                success=True,
            )
        ]
        return base_state

    @pytest.mark.asyncio
    async def test_saves_when_worth_remembering(self, base_state, memory_system):
        """reflect_node should save to long-term memory when worth_remembering=True."""
        state = self._make_reflect_state(base_state)

        llm = AsyncMock()
        llm.reflect.return_value = {
            "summary": "用户查询了AI行业动态，返回5篇文章",
            "lessons_learned": ["tavily搜索效果好"],
            "worth_remembering": True,
            "importance": 0.8,
        }

        ctx = {
            "llm_provider": llm,
            "memory_system": memory_system,
            "event_emitter": AsyncMock(),
        }
        result = await reflect_node(state, ctx)

        memory_system.save_long_term.assert_awaited_once_with(
            agent_id="agent_001",
            session_id="sess_001",
            content="用户查询了AI行业动态，返回5篇文章",
            importance=0.8,
            org_id="org_001",
            memory_type="semantic",
            metadata={"source": "reflection"},
        )
        assert result["reflection"].worth_remembering is True
        assert result["current_step"] == "respond"

    @pytest.mark.asyncio
    async def test_skips_when_not_worth_remembering(self, base_state, memory_system):
        """reflect_node should NOT save when worth_remembering=False."""
        state = self._make_reflect_state(base_state)

        llm = AsyncMock()
        llm.reflect.return_value = {
            "summary": "简单问候",
            "lessons_learned": [],
            "worth_remembering": False,
            "importance": 0.2,
        }

        ctx = {
            "llm_provider": llm,
            "memory_system": memory_system,
            "event_emitter": AsyncMock(),
        }
        result = await reflect_node(state, ctx)

        memory_system.save_long_term.assert_not_awaited()
        assert result["reflection"].worth_remembering is False

    @pytest.mark.asyncio
    async def test_no_memory_system(self, base_state):
        """reflect_node should work without memory_system (no save attempt)."""
        state = self._make_reflect_state(base_state)

        llm = AsyncMock()
        llm.reflect.return_value = {
            "summary": "Task done",
            "lessons_learned": [],
            "worth_remembering": True,
            "importance": 0.9,
        }

        ctx = {
            "llm_provider": llm,
            "event_emitter": AsyncMock(),
        }
        result = await reflect_node(state, ctx)

        # Should not crash, reflection still returned
        assert result["reflection"].worth_remembering is True
        assert result["current_step"] == "respond"

    @pytest.mark.asyncio
    async def test_save_long_term_exception_swallowed(self, base_state, memory_system):
        """Memory save errors should be caught — reflect_node must not crash."""
        state = self._make_reflect_state(base_state)
        memory_system.save_long_term.side_effect = Exception("pgvector connection lost")

        llm = AsyncMock()
        llm.reflect.return_value = {
            "summary": "Important insight",
            "lessons_learned": ["key lesson"],
            "worth_remembering": True,
            "importance": 0.9,
        }

        ctx = {
            "llm_provider": llm,
            "memory_system": memory_system,
            "event_emitter": AsyncMock(),
        }
        result = await reflect_node(state, ctx)

        # Should degrade gracefully
        memory_system.save_long_term.assert_awaited_once()
        assert result["reflection"].worth_remembering is True
        assert result["current_step"] == "respond"

    @pytest.mark.asyncio
    async def test_no_llm_provider(self, base_state, memory_system):
        """Without llm_provider, reflect_node uses default reflection (not worth remembering)."""
        state = self._make_reflect_state(base_state)

        ctx = {
            "memory_system": memory_system,
            "event_emitter": AsyncMock(),
        }
        result = await reflect_node(state, ctx)

        # Default reflection has worth_remembering=False
        memory_system.save_long_term.assert_not_awaited()
        assert result["reflection"].summary == "Task completed."
        assert result["reflection"].worth_remembering is False


# ===========================================================================
# respond_node — short-term memory saving
# ===========================================================================

class TestRespondNodeMemory:
    """Tests for short-term memory saving in respond_node."""

    @pytest.mark.asyncio
    async def test_saves_user_and_assistant_messages(self, base_state, memory_system):
        """respond_node should save both user message and assistant response to short-term memory."""
        llm = AsyncMock()
        llm.generate_response_stream = None  # force non-streaming path
        llm.generate_response = AsyncMock(return_value="这是AI行业最新动态的总结。")

        ctx = {
            "llm_provider": llm,
            "memory_system": memory_system,
            "event_emitter": None,
        }
        base_state["error"] = None
        result = await respond_node(base_state, ctx)

        assert memory_system.append_short_term.await_count == 2

        # First call: user message
        first_call = memory_system.append_short_term.call_args_list[0]
        assert first_call.kwargs["session_id"] == "sess_001"
        assert "[user]" in first_call.kwargs["content"]
        assert "帮我搜索AI新闻" in first_call.kwargs["content"]

        # Second call: assistant response
        second_call = memory_system.append_short_term.call_args_list[1]
        assert "[assistant]" in second_call.kwargs["content"]
        assert "AI行业最新动态" in second_call.kwargs["content"]

    @pytest.mark.asyncio
    async def test_no_memory_system(self, base_state):
        """respond_node should work without memory_system."""
        llm = AsyncMock()
        llm.generate_response_stream = None
        llm.generate_response = AsyncMock(return_value="回复内容")

        ctx = {
            "llm_provider": llm,
        }
        result = await respond_node(base_state, ctx)

        assert result["messages"][0]["content"] == "回复内容"

    @pytest.mark.asyncio
    async def test_memory_save_exception_swallowed(self, base_state, memory_system):
        """Short-term memory save errors should not crash respond_node."""
        memory_system.append_short_term.side_effect = ConnectionError("Redis timeout")

        llm = AsyncMock()
        llm.generate_response_stream = None
        llm.generate_response = AsyncMock(return_value="正常回复")

        ctx = {
            "llm_provider": llm,
            "memory_system": memory_system,
        }
        result = await respond_node(base_state, ctx)

        # Response should still be returned
        assert result["messages"][0]["content"] == "正常回复"

    @pytest.mark.asyncio
    async def test_error_state_skips_memory(self, base_state, memory_system):
        """When state has error, respond_node emits error message — memory save is skipped."""
        base_state["error"] = "Something went wrong"

        ctx = {
            "memory_system": memory_system,
            "event_emitter": AsyncMock(),
        }
        result = await respond_node(base_state, ctx)

        # Error path returns early before memory save
        assert "error" in result["messages"][0]["content"].lower() or "Error" in result["messages"][0]["content"]
        memory_system.append_short_term.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_streaming_response_saves_memory(self, base_state, memory_system):
        """respond_node with streaming should still save to short-term memory."""
        async def mock_stream(*args, **kwargs):
            for chunk in ["这是", "流式", "回复"]:
                yield chunk

        llm = AsyncMock()
        llm.generate_response_stream = mock_stream

        event_emitter = AsyncMock()

        ctx = {
            "llm_provider": llm,
            "memory_system": memory_system,
            "event_emitter": event_emitter,
        }

        # Need agent config for model extraction
        base_state["context"] = None

        result = await respond_node(base_state, ctx)

        assert result["messages"][0]["content"] == "这是流式回复"
        assert memory_system.append_short_term.await_count == 2

        # Verify assistant message content
        second_call = memory_system.append_short_term.call_args_list[1]
        assert "这是流式回复" in second_call.kwargs["content"]

    @pytest.mark.asyncio
    async def test_empty_response_uses_deterministic_fallback_and_saves_assistant(self, base_state, memory_system):
        """When LLM returns empty response, respond_node should use deterministic fallback."""
        llm = AsyncMock()
        llm.generate_response_stream = None
        llm.generate_response = AsyncMock(return_value="")

        ctx = {
            "llm_provider": llm,
            "memory_system": memory_system,
        }
        result = await respond_node(base_state, ctx)

        assert result["messages"][0]["content"] == "任务已完成。"
        assert memory_system.append_short_term.await_count == 2
        first_call = memory_system.append_short_term.call_args_list[0]
        assert "[user]" in first_call.kwargs["content"]
        second_call = memory_system.append_short_term.call_args_list[1]
        assert "[assistant] 任务已完成。" == second_call.kwargs["content"]

    @pytest.mark.asyncio
    async def test_memory_context_passed_to_llm(self, base_state, memory_system):
        """respond_node should prefer structured memory_snapshot when present."""
        base_state["memory_context"] = "stale memory"
        base_state["memory_snapshot"]["memory_context"] = "Recent context:\n[user] 记住偏好：最喜欢蓝色\n[assistant] 已记录。"

        llm = AsyncMock()
        llm.generate_response_stream = None
        llm.generate_response = AsyncMock(return_value="你最喜欢的颜色是蓝色。")

        ctx = {
            "llm_provider": llm,
            "memory_system": memory_system,
        }
        result = await respond_node(base_state, ctx)

        # Verify memory_context was passed to generate_response
        call_kwargs = llm.generate_response.call_args.kwargs
        assert call_kwargs["memory_context"] == base_state["memory_snapshot"]["memory_context"]

    @pytest.mark.asyncio
    async def test_memory_context_passed_to_llm_stream(self, base_state, memory_system):
        """respond_node streaming path should also prefer structured memory_snapshot."""
        base_state["memory_context"] = "stale memory"
        base_state["memory_snapshot"]["memory_context"] = "Relevant knowledge:\n用户偏好中文回复"

        async def mock_stream(*args, **kwargs):
            for chunk in ["好的", "，收到"]:
                yield chunk

        llm = AsyncMock()
        llm.generate_response_stream = mock_stream

        event_emitter = AsyncMock()
        ctx = {
            "llm_provider": llm,
            "memory_system": memory_system,
            "event_emitter": event_emitter,
        }
        base_state["context"] = None
        result = await respond_node(base_state, ctx)

        assert result["messages"][0]["content"] == "好的，收到"

    @pytest.mark.asyncio
    async def test_conversation_history_preserved(self, base_state, memory_system):
        """respond_node should pass both user and assistant messages to LLM, not just user."""
        base_state["messages"] = [
            Message(role="user", content="记住：我喜欢蓝色", name=None, tool_call_id=None),
            Message(role="assistant", content="已记录。", name=None, tool_call_id=None),
            Message(role="user", content="我喜欢什么颜色？", name=None, tool_call_id=None),
        ]

        llm = AsyncMock()
        llm.generate_response_stream = None
        llm.generate_response = AsyncMock(return_value="你喜欢蓝色。")

        ctx = {
            "llm_provider": llm,
            "memory_system": memory_system,
        }
        result = await respond_node(base_state, ctx)

        # Verify all 3 messages (user+assistant+user) were passed, not just user messages
        call_kwargs = llm.generate_response.call_args.kwargs
        passed_messages = call_kwargs["messages"]
        roles = [m.get("role") for m in passed_messages]
        # First is system, then the conversation
        assert "assistant" in roles, "Assistant messages should be included in conversation history"
