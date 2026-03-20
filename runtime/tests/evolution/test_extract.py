"""EvolutionEngine._extract tests."""

import pytest
import json
from unittest.mock import Mock, AsyncMock
from src.evolution.engine import EvolutionEngine
from tests.evolution.conftest import make_state


class TestExtract:
    """_extract 技能提取测试"""

    @pytest.fixture
    def engine(self):
        llm = Mock()
        llm.chat = AsyncMock()
        return EvolutionEngine(
            llm=llm, memory_system=Mock(),
            skill_registry=Mock(), db_pool=Mock(),
        )

    @pytest.mark.asyncio
    async def test_extract_success(self, engine):
        engine.llm.chat.return_value = json.dumps({
            "name": "查询订单",
            "description": "查询订单状态",
            "trigger_keywords": ["订单"],
            "steps": [{"order": 1, "action": "查询", "tool": "query"}],
            "tools_used": ["query"],
            "parameters": {},
            "preconditions": {},
            "expected_outcome": "返回订单状态",
            "reusability_score": 0.8,
        })

        state = make_state()
        draft = await engine._extract(state)
        assert draft is not None
        assert draft.name == "查询订单"
        assert draft.reusability_score == 0.8

    @pytest.mark.asyncio
    async def test_extract_invalid_json(self, engine):
        engine.llm.chat.return_value = "这不是 JSON"

        state = make_state()
        draft = await engine._extract(state)
        assert draft is None

    @pytest.mark.asyncio
    async def test_extract_missing_required_fields(self, engine):
        """缺少 name 字段应返回 None（KeyError）"""
        engine.llm.chat.return_value = json.dumps({
            "description": "只有描述",
        })

        state = make_state()
        draft = await engine._extract(state)
        assert draft is None

    @pytest.mark.asyncio
    async def test_extract_minimal_fields(self, engine):
        """只有 name 和 description 时应成功（其余有默认值）"""
        engine.llm.chat.return_value = json.dumps({
            "name": "最小技能",
            "description": "最小描述",
        })

        state = make_state()
        draft = await engine._extract(state)
        assert draft is not None
        assert draft.name == "最小技能"
        assert draft.steps == []
        assert draft.tools_used == []
