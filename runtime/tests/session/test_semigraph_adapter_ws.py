from __future__ import annotations

import asyncio
import contextlib
from pathlib import Path
from unittest.mock import AsyncMock

import pytest

from src.events.event_engine import EventEngine
from src.session.semigraph_adapter import SemiGraphAdapter, SemiGraphOrchestratorBridge


class DummyClient:
    def __init__(self) -> None:
        self.sse_events: list[tuple[str, dict]] = []
        self.runtime_events: list[tuple[str, dict]] = []
        self.fire_and_forget_calls: list[tuple[str, str, dict]] = []

    async def send_sse_event(self, session_id: str, payload: dict) -> None:
        self.sse_events.append((session_id, payload))

    async def send_runtime_event(self, session_id: str, event: dict) -> None:
        self.runtime_events.append((session_id, event))

    async def request(self, session_id: str, method: str, **params):
        assert method == "memory_search"
        return {"results": [{"content": "memo"}]}

    async def fire_and_forget(self, session_id: str, method: str, **params):
        self.fire_and_forget_calls.append((session_id, method, params))


class DummyGraph:
    async def ainvoke(self, _state):
        return {
            "messages": [
                {"role": "assistant", "content": "done"}
            ]
        }


class DummyGraphPrematureResponse:
    async def ainvoke(self, _state):
        return {
            "messages": [
                {
                    "role": "assistant",
                    "content": "好的，我将使用深度研究技能分析拼多多股票，重点关注其财务表现、市场趋势以及投资价值。稍等，我会提供详细的结果。",
                }
            ],
            "tool_results": [
                {
                    "tool_name": "search",
                    "params": {"query": "拼多多股票 最新 财报"},
                    "result": {
                        "results": [
                            {
                                "title": "PDD Investor Relations",
                                "url": "https://investor.pddholdings.com",
                                "content": "Contains financial reports and earnings releases.",
                            }
                        ]
                    },
                    "success": True,
                }
            ],
        }


@pytest.mark.asyncio
async def test_semigraph_adapter_emits_completion(monkeypatch):
    import src.session.semigraph_adapter as mod

    monkeypatch.setattr(mod, "create_agent_graph", lambda context, runtime_context: DummyGraph())

    client = DummyClient()
    memory_dir = "/tmp/semibot-test-memory"
    adapter = SemiGraphAdapter(
        client=client,
        session_id="sess-1",
        org_id="org-1",
        user_id="user-1",
        init_data={"api_keys": {}, "memory_dir": memory_dir},
        start_payload={
            "agent_id": "agent-1",
            "agent_config": {"model": "gpt-4o"},
            "mcp_servers": [],
        },
    )

    await adapter.start()
    await adapter.handle_user_message({"message": "hello", "history": []})
    assert adapter._task is not None
    await asyncio.wait_for(adapter._task, timeout=3)

    assert any(payload.get("type") == "execution_complete" for _, payload in client.sse_events)
    assert any(method == "snapshot_sync" for _, method, _ in client.fire_and_forget_calls)

    cp_dir = Path(memory_dir) / "sess-1" / "checkpoints"
    files = list(cp_dir.glob("*.json"))
    assert len(files) >= 1


@pytest.mark.asyncio
async def test_semigraph_adapter_rewrites_premature_final_response(monkeypatch):
    import src.session.semigraph_adapter as mod

    monkeypatch.setattr(mod, "create_agent_graph", lambda context, runtime_context: DummyGraphPrematureResponse())

    client = DummyClient()
    adapter = SemiGraphAdapter(
        client=client,
        session_id="sess-premature",
        org_id="org-1",
        user_id="user-1",
        init_data={"api_keys": {}, "memory_dir": "/tmp/semibot-test-memory"},
        start_payload={
            "agent_id": "agent-1",
            "agent_config": {"model": "gpt-4o"},
            "mcp_servers": [],
        },
    )

    await adapter.start()
    await adapter.handle_user_message({"message": "使用深度研究技能研究拼多多股票", "history": []})
    assert adapter._task is not None
    await asyncio.wait_for(adapter._task, timeout=3)

    completion_events = [payload for _, payload in client.sse_events if payload.get("type") == "execution_complete"]
    assert completion_events
    final_response = str(completion_events[-1].get("final_response") or "")
    assert "我将使用深度研究技能" not in final_response
    assert "已完成对" in final_response


@pytest.mark.asyncio
async def test_semigraph_adapter_cancel(monkeypatch):
    import src.session.semigraph_adapter as mod

    class SlowGraph:
        async def ainvoke(self, _state):
            await asyncio.sleep(1)
            return {"messages": [{"role": "assistant", "content": "slow"}]}

    monkeypatch.setattr(mod, "create_agent_graph", lambda context, runtime_context: SlowGraph())

    client = DummyClient()
    adapter = SemiGraphAdapter(
        client=client,
        session_id="sess-2",
        org_id="org-1",
        user_id="user-1",
        init_data={"api_keys": {}, "memory_dir": "/tmp/semibot-test-memory"},
        start_payload={"agent_id": "agent-1", "agent_config": {}, "mcp_servers": []},
    )

    await adapter.handle_user_message({"message": "hello"})
    await adapter.cancel()

    if adapter._task is not None:
        with contextlib.suppress(asyncio.CancelledError):
            await asyncio.wait_for(adapter._task, timeout=3)

    assert any(payload.get("type") == "execution_complete" and payload.get("cancelled") is True for _, payload in client.sse_events)
    assert any(method == "snapshot_sync" for _, method, _ in client.fire_and_forget_calls)


@pytest.mark.asyncio
async def test_semigraph_adapter_restores_history_from_checkpoint(monkeypatch):
    import src.session.semigraph_adapter as mod

    monkeypatch.setattr(mod, "create_agent_graph", lambda context, runtime_context: DummyGraph())
    captured_histories: list[object] = []

    def fake_create_initial_state(*, history_messages=None, **kwargs):
        del kwargs
        captured_histories.append(history_messages)
        return {}

    monkeypatch.setattr(mod, "create_initial_state", fake_create_initial_state)

    client = DummyClient()
    adapter = SemiGraphAdapter(
        client=client,
        session_id="sess-restore",
        org_id="org-1",
        user_id="user-1",
        init_data={"api_keys": {}, "memory_dir": "/tmp/semibot-test-memory"},
        start_payload={"agent_id": "agent-1", "agent_config": {}, "mcp_servers": []},
    )

    await adapter.handle_user_message({"message": "hello", "history": [{"role": "user", "content": "h1"}]})
    assert adapter._task is not None
    await asyncio.wait_for(adapter._task, timeout=3)

    await adapter.handle_user_message({"message": "next"})
    assert adapter._task is not None
    await asyncio.wait_for(adapter._task, timeout=3)

    assert captured_histories[0] == [{"role": "user", "content": "h1"}]
    assert captured_histories[1] == [{"role": "assistant", "content": "done"}]


def test_semigraph_adapter_keeps_skill_index_skills_in_capabilities():
    adapter = SemiGraphAdapter(
        client=DummyClient(),
        session_id="sess-skill-filter",
        org_id="org-1",
        user_id="user-1",
        init_data={"api_keys": {}, "memory_dir": "/tmp/semibot-test-memory"},
        start_payload={
            "agent_id": "agent-1",
            "agent_config": {},
            "mcp_servers": [],
            "skill_index": [
                {"id": "unregistered-demo-skill", "name": "unregistered-demo-skill"},
                {"id": "code_executor", "name": "code_executor"},
            ],
        },
    )

    defs = adapter._build_skill_definitions()
    names = [d.name for d in defs]
    assert "unregistered-demo-skill" in names
    assert "code_executor" in names


def test_semigraph_adapter_does_not_register_skill_as_tool():
    adapter = SemiGraphAdapter(
        client=DummyClient(),
        session_id="sess-package-tool",
        org_id="org-1",
        user_id="user-1",
        init_data={"api_keys": {}, "memory_dir": "/tmp/semibot-test-memory"},
        start_payload={
            "agent_id": "agent-1",
            "agent_config": {},
            "mcp_servers": [],
            "skill_index": [
                {
                    "id": "pkg-skill-demo",
                    "name": "pkg-skill-demo",
                    "package": {
                        "files": [
                            {"path": "scripts/main.py", "content": "print('hello package')", "encoding": "utf-8"},
                        ],
                    },
                },
            ],
        },
    )

    adapter._register_skill_tools()
    assert adapter.skill_registry.get_tool("pkg-skill-demo") is None


def test_semigraph_adapter_doc_only_skill_not_registered_as_tool():
    adapter = SemiGraphAdapter(
        client=DummyClient(),
        session_id="sess-instruction-skill",
        org_id="org-1",
        user_id="user-1",
        init_data={"api_keys": {}, "memory_dir": "/tmp/semibot-test-memory"},
        start_payload={
            "agent_id": "agent-1",
            "agent_config": {},
            "mcp_servers": [],
            "skill_index": [
                {
                    "id": "instruction-only",
                    "name": "instruction-only",
                    "package": {
                        "files": [
                            {"path": "SKILL.md", "content": "# Skill", "encoding": "utf-8"},
                        ],
                    },
                },
            ],
        },
    )

    adapter._register_skill_tools()
    assert adapter.skill_registry.get_tool("instruction-only") is None


def test_semigraph_adapter_uses_runtime_init_llm_config_for_custom_provider():
    adapter = SemiGraphAdapter(
        client=DummyClient(),
        session_id="sess-llm-init",
        org_id="org-1",
        user_id="user-1",
        init_data={
            "api_keys": {"custom": "sk-custom"},
            "llm_config": {
                "default_model": "qwen-plus",
                "providers": {
                    "custom": {
                        "base_url": "https://custom.example.com/v1",
                    },
                },
            },
            "memory_dir": "/tmp/semibot-test-memory",
        },
        start_payload={"agent_id": "agent-1", "agent_config": {}, "mcp_servers": []},
    )

    assert adapter.llm_provider is not None
    assert adapter.llm_provider.config.model == "qwen-plus"
    assert adapter.llm_provider.config.base_url == "https://custom.example.com/v1"


def test_semigraph_adapter_prefers_kimi_instance_when_model_is_kimi():
    adapter = SemiGraphAdapter(
        client=DummyClient(),
        session_id="sess-llm-kimi",
        org_id="org-1",
        user_id="user-1",
        init_data={
            "api_keys": {
                "openai": "sk-openai",
                "custom": "sk-custom",
                "kimi:kimiprovider": "sk-kimi-instance",
            },
            "llm_config": {
                "default_model": "kimi-k2.5",
                "providers": {
                    "openai": {"base_url": "https://api.openai.com/v1"},
                    "custom": {"base_url": "https://custom.example.com/v1"},
                    "kimi:kimiprovider": {"base_url": "https://api.moonshot.cn/v1"},
                },
            },
            "memory_dir": "/tmp/semibot-test-memory",
        },
        start_payload={"agent_id": "agent-1", "agent_config": {}, "mcp_servers": []},
    )

    assert adapter.llm_provider is not None
    assert adapter.llm_provider.config.model == "kimi-k2.5"
    assert adapter.llm_provider.config.api_key == "sk-kimi-instance"
    assert adapter.llm_provider.config.base_url == "https://api.moonshot.cn/v1"


def test_semigraph_adapter_falls_back_to_default_model_when_agent_model_provider_unavailable():
    adapter = SemiGraphAdapter(
        client=DummyClient(),
        session_id="sess-llm-fallback-default",
        org_id="org-1",
        user_id="user-1",
        init_data={
            "api_keys": {
                "custom": "sk-custom",
                "kimi:kimiprovider": "sk-kimi-instance",
            },
            "llm_config": {
                "default_model": "kimi-k2.5",
                "providers": {
                    "custom": {"base_url": "https://custom.example.com/v1"},
                    "kimi:kimiprovider": {"base_url": "https://api.moonshot.cn/v1"},
                },
            },
            "memory_dir": "/tmp/semibot-test-memory",
        },
        start_payload={
            "agent_id": "agent-1",
            "agent_config": {"model": "gpt-4o"},
            "mcp_servers": [],
        },
    )

    assert adapter.llm_provider is not None
    assert adapter.llm_provider.config.model == "kimi-k2.5"
    assert adapter.llm_provider.config.api_key == "sk-kimi-instance"
    assert adapter.llm_provider.config.base_url == "https://api.moonshot.cn/v1"


def test_semigraph_adapter_honors_default_provider_key():
    adapter = SemiGraphAdapter(
        client=DummyClient(),
        session_id="sess-llm-default-provider",
        org_id="org-1",
        user_id="user-1",
        init_data={
            "api_keys": {
                "custom": "sk-custom",
                "kimi:kimiprovider": "sk-kimi-instance",
            },
            "llm_config": {
                "default_model": "kimi-k2.5",
                "default_provider_key": "kimi:kimiprovider",
                "providers": {
                    "custom": {"base_url": "https://custom.example.com/v1"},
                    "kimi:kimiprovider": {"base_url": "https://api.moonshot.cn/v1"},
                },
            },
            "memory_dir": "/tmp/semibot-test-memory",
        },
        start_payload={"agent_id": "agent-1", "agent_config": {}, "mcp_servers": []},
    )

    assert adapter.llm_provider is not None
    assert adapter.llm_provider.config.model == "kimi-k2.5"
    assert adapter.llm_provider.config.api_key == "sk-kimi-instance"
    assert adapter.llm_provider.config.base_url == "https://api.moonshot.cn/v1"


@pytest.mark.asyncio
async def test_semigraph_adapter_update_config_rebuilds_llm_provider():
    adapter = SemiGraphAdapter(
        client=DummyClient(),
        session_id="sess-llm-update",
        org_id="org-1",
        user_id="user-1",
        init_data={"api_keys": {}, "memory_dir": "/tmp/semibot-test-memory"},
        start_payload={"agent_id": "agent-1", "agent_config": {}, "mcp_servers": []},
    )
    assert adapter.llm_provider is None

    await adapter.update_config(
        {
            "api_keys": {"custom": "sk-custom-new"},
            "llm_config": {
                "default_model": "qwen-plus",
                "providers": {
                    "custom": {"base_url": "https://custom.example.com/v1"},
                },
            },
        }
    )

    assert adapter.llm_provider is not None
    assert adapter.llm_provider.config.model == "qwen-plus"
    assert adapter.llm_provider.config.base_url == "https://custom.example.com/v1"


@pytest.mark.asyncio
async def test_semigraph_adapter_injects_event_engine_into_runtime_context(monkeypatch):
    import src.session.semigraph_adapter as mod

    captured_context = {}

    def fake_create_agent_graph(context, runtime_context):
        captured_context["runtime_context"] = runtime_context
        return DummyGraph()

    monkeypatch.setattr(mod, "create_agent_graph", fake_create_agent_graph)

    client = DummyClient()
    tmp_rules = Path("/tmp/semibot-test-rules")
    tmp_rules.mkdir(parents=True, exist_ok=True)
    adapter = SemiGraphAdapter(
        client=client,
        session_id="sess-event-engine",
        org_id="org-1",
        user_id="user-1",
        init_data={"api_keys": {}, "memory_dir": "/tmp/semibot-test-memory", "rules_path": str(tmp_rules)},
        start_payload={"agent_id": "agent-1", "agent_config": {}, "mcp_servers": []},
    )

    await adapter.handle_user_message({"message": "hello"})
    assert adapter._task is not None
    await asyncio.wait_for(adapter._task, timeout=3)

    runtime_context = captured_context.get("runtime_context")
    assert runtime_context is not None
    emitter = runtime_context.metadata.get("event_emitter")
    assert isinstance(emitter, EventEngine)


@pytest.mark.asyncio
async def test_semigraph_adapter_run_rule_triggered_agent(monkeypatch):
    import src.session.semigraph_adapter as mod

    monkeypatch.setattr(mod, "create_agent_graph", lambda context, runtime_context: DummyGraph())

    client = DummyClient()
    adapter = SemiGraphAdapter(
        client=client,
        session_id="sess-rule-agent",
        org_id="org-1",
        user_id="user-1",
        init_data={"api_keys": {}, "memory_dir": "/tmp/semibot-test-memory"},
        start_payload={"agent_id": "agent-1", "agent_config": {}, "mcp_servers": []},
    )

    result = await adapter._run_rule_triggered_agent(
        agent_id="agent-worker",
        message="请处理任务",
        trace_id="trace_123",
        payload={"task": "demo"},
    )
    assert result["success"] is True
    assert result["agent_id"] == "agent-worker"
    assert any(event.get("event") == "rule.run_agent.completed" for _, event in client.runtime_events)


@pytest.mark.asyncio
async def test_semigraph_adapter_run_rule_triggered_agent_uses_sub_agent_config(monkeypatch):
    import src.session.semigraph_adapter as mod

    captured = {}

    def fake_create_agent_graph(context, runtime_context):
        captured["runtime_context"] = runtime_context
        return DummyGraph()

    monkeypatch.setattr(mod, "create_agent_graph", fake_create_agent_graph)

    client = DummyClient()
    adapter = SemiGraphAdapter(
        client=client,
        session_id="sess-rule-sub-agent",
        org_id="org-1",
        user_id="user-1",
        init_data={"api_keys": {}, "memory_dir": "/tmp/semibot-test-memory"},
        start_payload={
            "agent_id": "agent-main",
            "agent_config": {"model": "gpt-main"},
            "mcp_servers": [],
            "sub_agents": [
                {
                    "id": "risk-officer",
                    "name": "Risk Officer",
                    "model": "gpt-risk",
                    "system_prompt": "你是风控官。",
                    "temperature": 0.2,
                }
            ],
        },
    )

    result = await adapter._run_rule_triggered_agent(
        agent_id="risk-officer",
        message="评估风险",
        trace_id="trace_sub",
        payload={"task": "risk"},
    )
    assert result["success"] is True
    runtime_context = captured["runtime_context"]
    assert runtime_context.agent_config.id == "risk-officer"
    assert runtime_context.agent_config.model == "gpt-risk"
    assert runtime_context.agent_config.system_prompt == "你是风控官。"


@pytest.mark.asyncio
async def test_semigraph_bridge_queues_rule_run_agent_job(monkeypatch):
    client = DummyClient()
    adapter = SemiGraphAdapter(
        client=client,
        session_id="sess-queue",
        org_id="org-1",
        user_id="user-1",
        init_data={"api_keys": {}, "memory_dir": "/tmp/semibot-test-memory"},
        start_payload={"agent_id": "agent-main", "agent_config": {}, "mcp_servers": []},
    )
    runner = AsyncMock(return_value={"success": True})
    monkeypatch.setattr(adapter, "_run_rule_triggered_agent", runner)

    bridge = SemiGraphOrchestratorBridge(adapter)
    accepted = await bridge.run_agent("agent-worker", {"task": "x"}, "trace_queue_1")
    assert accepted["accepted"] is True

    await asyncio.sleep(0.05)
    runner.assert_awaited_once()
    assert any(event.get("event") == "rule.queue.accepted" for _, event in client.runtime_events)
    snapshot = await adapter.get_snapshot()
    assert snapshot is not None
    assert "queue_state" in snapshot
    await adapter._shutdown_rule_workers()
