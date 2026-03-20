"""EvolutionEngine._validate tests."""

import pytest
import json
from unittest.mock import Mock, AsyncMock
from src.evolution.engine import EvolutionEngine
from src.evolution.models import SkillDraft
from tests.evolution.conftest import make_state


class TestValidate:
    """_validate 技能验证测试"""

    @pytest.fixture
    def engine(self):
        memory = Mock()
        memory.search_evolved_skills = AsyncMock(return_value=[])
        llm = Mock()
        llm.chat = AsyncMock(return_value=json.dumps({
            "score": 0.8, "reusability": 0.7,
        }))
        eng = EvolutionEngine(
            llm=llm, memory_system=memory,
            skill_registry=Mock(), db_pool=Mock(),
        )
        return eng

    def _make_valid_draft(self, **overrides):
        base = dict(
            name="测试技能",
            description="测试描述",
            steps=[{"order": 1, "action": "test", "tool": "t"}],
            tools_used=["t"],
        )
        base.update(overrides)
        return SkillDraft(**base)

    @pytest.mark.asyncio
    async def test_validate_success(self, engine):
        draft = self._make_valid_draft()
        state = make_state()
        result = await engine._validate(draft, state)
        assert result is True
        assert draft.quality_score == 0.8

    @pytest.mark.asyncio
    async def test_validate_fail_incomplete(self, engine):
        draft = SkillDraft(name="", description="desc")
        state = make_state()
        result = await engine._validate(draft, state)
        assert result is False

    @pytest.mark.asyncio
    async def test_validate_fail_duplicate(self, engine):
        engine.memory.search_evolved_skills.return_value = [
            {"name": "已有技能", "similarity": 0.9}
        ]
        draft = self._make_valid_draft()
        state = make_state()
        result = await engine._validate(draft, state)
        assert result is False

    @pytest.mark.asyncio
    async def test_validate_fail_low_quality(self, engine):
        engine.llm.chat.return_value = json.dumps({
            "score": 0.3, "reusability": 0.2,
        })
        draft = self._make_valid_draft()
        state = make_state(agent_config={"evolution": {"enabled": True, "min_quality_score": 0.6}})
        result = await engine._validate(draft, state)
        assert result is False

    @pytest.mark.asyncio
    async def test_validate_fail_unsafe(self, engine):
        draft = self._make_valid_draft(
            steps=[{"order": 1, "action": "rm -rf /", "tool": "shell"}],
            tools_used=["shell"],
        )
        state = make_state()
        result = await engine._validate(draft, state)
        assert result is False

    @pytest.mark.asyncio
    async def test_validate_uses_default_min_quality(self, engine):
        """未配置 min_quality_score 时使用默认值 0.6"""
        engine.llm.chat.return_value = json.dumps({
            "score": 0.55, "reusability": 0.5,
        })
        draft = self._make_valid_draft()
        state = make_state(agent_config={"evolution": {"enabled": True}})
        result = await engine._validate(draft, state)
        assert result is False
