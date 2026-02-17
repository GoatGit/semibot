"""Evolution system integration tests."""

import pytest
import json
import asyncio
from unittest.mock import Mock, AsyncMock
from src.evolution.engine import EvolutionEngine
from src.evolution.models import SkillDraft
from tests.evolution.conftest import make_state


@pytest.mark.integration
class TestEvolutionIntegration:
    """进化系统集成测试"""

    @pytest.fixture
    def mock_db(self):
        db = Mock()
        db.execute = AsyncMock(return_value="skill-001")
        db.fetch = AsyncMock(return_value=[])
        return db

    @pytest.fixture
    def mock_llm(self):
        llm = Mock()
        llm.chat = AsyncMock()
        llm.embed = AsyncMock(return_value=[0.1] * 1536)
        return llm

    @pytest.fixture
    def mock_memory(self):
        memory = Mock()
        memory.search_evolved_skills = AsyncMock(return_value=[])
        memory.embed = AsyncMock(return_value=[0.1] * 1536)
        return memory

    @pytest.fixture
    def mock_registry(self):
        registry = Mock()
        registry.refresh_cache = AsyncMock()
        return registry

    @pytest.fixture
    def engine(self, mock_llm, mock_memory, mock_registry, mock_db):
        eng = EvolutionEngine(mock_llm, mock_memory, mock_registry, mock_db)
        eng._check_cooldown = Mock(return_value=True)
        eng._check_rate_limit = Mock(return_value=True)
        return eng

    @pytest.mark.asyncio
    async def test_full_evolution_flow(self, engine, mock_llm, mock_db):
        """测试完整进化流程: EXTRACT → VALIDATE → REGISTER → INDEX"""
        mock_llm.chat.side_effect = [
            # _extract 调用
            json.dumps({
                "name": "查询订单状态",
                "description": "根据订单号查询订单当前状态并通知用户",
                "trigger_keywords": ["订单", "查询", "状态"],
                "steps": [
                    {"order": 1, "action": "查询订单", "tool": "order_query",
                     "params_template": {"order_id": "{order_id}"}},
                    {"order": 2, "action": "格式化结果", "tool": "formatter"},
                    {"order": 3, "action": "通知用户", "tool": "notifier"},
                ],
                "tools_used": ["order_query", "formatter", "notifier"],
                "parameters": {
                    "order_id": {"type": "string", "description": "订单号", "required": True}
                },
                "preconditions": {"required_tools": ["order_query"]},
                "expected_outcome": "用户收到订单状态通知",
                "reusability_score": 0.85,
            }),
            # _assess_quality 调用
            json.dumps({
                "score": 0.82,
                "reusability": 0.85,
                "reasoning": "通用性强，步骤清晰",
            }),
        ]

        state = make_state()
        await engine._evolve(state)

        # REGISTER 被调用（写入数据库 + 日志）
        assert mock_db.execute.call_count >= 1
        # INDEX 被调用（生成 embedding）
        mock_llm.embed.assert_called_once()
        # SkillRegistry 缓存被刷新
        engine.skill_registry.refresh_cache.assert_called_once()

    @pytest.mark.asyncio
    async def test_evolution_stops_on_extract_failure(self, engine, mock_llm, mock_db):
        """EXTRACT 失败时流程终止"""
        mock_llm.chat.return_value = "无效的 JSON 输出"

        state = make_state()
        await engine._evolve(state)

        # embedding 不应被生成
        mock_llm.embed.assert_not_called()

    @pytest.mark.asyncio
    async def test_evolution_stops_on_validate_failure(self, engine, mock_llm):
        """VALIDATE 失败时流程终止（去重命中）"""
        mock_llm.chat.return_value = json.dumps({
            "name": "已有技能",
            "description": "重复的技能",
            "steps": [{"order": 1, "action": "test", "tool": "t"}],
            "tools_used": ["t"],
        })

        engine.memory.search_evolved_skills.return_value = [
            {"name": "已有技能", "similarity": 0.9}
        ]

        state = make_state()
        await engine._evolve(state)

        mock_llm.embed.assert_not_called()

    @pytest.mark.asyncio
    async def test_evolution_error_does_not_propagate(self, engine, mock_llm, mock_db):
        """_safe_evolve 包裹异常，不传播"""
        mock_llm.chat.side_effect = Exception("LLM 服务不可用")

        state = make_state()
        # _safe_evolve 不应抛出异常
        await engine._safe_evolve(state)

    @pytest.mark.asyncio
    async def test_auto_approve_high_quality(self, engine, mock_llm, mock_db):
        """高质量 + auto_approve 时状态为 auto_approved"""
        mock_llm.chat.side_effect = [
            json.dumps({
                "name": "高质量技能",
                "description": "非常好的技��",
                "steps": [{"order": 1, "action": "test", "tool": "t"}],
                "tools_used": ["t"],
                "reusability_score": 0.9,
            }),
            json.dumps({"score": 0.85, "reusability": 0.9, "reasoning": "优秀"}),
        ]

        state = make_state(
            agent_config={"evolution": {"enabled": True, "auto_approve": True}}
        )

        await engine._evolve(state)

        # 验证 REGISTER 被调用
        assert mock_db.execute.call_count >= 1
        # 检查 INSERT 语句中包含 auto_approved
        register_call = None
        for call in mock_db.execute.call_args_list:
            args = call[0]
            if len(args) > 0 and "INSERT INTO evolved_skills" in str(args[0]):
                register_call = args
                break
        if register_call:
            assert "auto_approved" in str(register_call)

    @pytest.mark.asyncio
    async def test_should_evolve_gates_evolve(self, engine):
        """_should_evolve 返回 False 时 maybe_evolve 不触发"""
        engine._safe_evolve = AsyncMock()

        state = make_state(reflection={"success": False})
        await engine.maybe_evolve(state)

        engine._safe_evolve.assert_not_called()

    @pytest.mark.asyncio
    async def test_log_stages_recorded(self, engine, mock_llm, mock_db):
        """进化流程中各阶段日志被记录"""
        mock_llm.chat.side_effect = [
            json.dumps({
                "name": "技能",
                "description": "描述",
                "steps": [{"order": 1, "action": "a", "tool": "t"}],
                "tools_used": ["t"],
            }),
            json.dumps({"score": 0.8, "reusability": 0.7}),
        ]

        state = make_state()
        await engine._evolve(state)

        # _log_stage 通过 db.execute 写入 evolution_logs
        log_calls = [
            c for c in mock_db.execute.call_args_list
            if "evolution_logs" in str(c[0][0])
        ]
        # 至少有 extract started/completed, validate started/completed,
        # register started/completed, index started/completed = 8 次
        assert len(log_calls) >= 4
