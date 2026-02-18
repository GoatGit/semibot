"""EvolutionEngine._should_evolve trigger condition tests."""

import pytest
from unittest.mock import AsyncMock, Mock
from src.evolution.engine import EvolutionEngine
from tests.evolution.conftest import make_state


class TestShouldEvolve:
    """_should_evolve 触发条件测试"""

    @pytest.fixture
    def engine(self):
        eng = EvolutionEngine(
            llm=Mock(), memory_system=Mock(),
            skill_registry=Mock(), db_pool=Mock(),
        )
        eng._check_cooldown = AsyncMock(return_value=True)
        eng._check_rate_limit = AsyncMock(return_value=True)
        return eng

    @pytest.mark.asyncio
    async def test_should_evolve_all_conditions_met(self, engine):
        state = make_state()
        assert await engine._should_evolve(state) is True

    @pytest.mark.asyncio
    async def test_skip_when_task_failed(self, engine):
        state = make_state(reflection={"success": False})
        assert await engine._should_evolve(state) is False

    @pytest.mark.asyncio
    async def test_skip_when_reflection_missing_success(self, engine):
        state = make_state(reflection={})
        assert await engine._should_evolve(state) is False

    @pytest.mark.asyncio
    async def test_skip_when_steps_insufficient(self, engine):
        state = make_state(tool_results=[{"r": 1}, {"r": 2}])
        assert await engine._should_evolve(state) is False

    @pytest.mark.asyncio
    async def test_skip_when_evolution_disabled(self, engine):
        state = make_state(agent_config={"evolution": {"enabled": False}})
        assert await engine._should_evolve(state) is False

    @pytest.mark.asyncio
    async def test_skip_when_no_evolution_config(self, engine):
        state = make_state(agent_config={})
        assert await engine._should_evolve(state) is False

    @pytest.mark.asyncio
    async def test_skip_when_cooldown_active(self, engine):
        engine._check_cooldown = AsyncMock(return_value=False)
        state = make_state()
        assert await engine._should_evolve(state) is False

    @pytest.mark.asyncio
    async def test_skip_when_rate_limited(self, engine):
        engine._check_rate_limit = AsyncMock(return_value=False)
        state = make_state()
        assert await engine._should_evolve(state) is False

    @pytest.mark.asyncio
    async def test_boundary_exactly_3_steps(self, engine):
        state = make_state(tool_results=[{"r": 1}, {"r": 2}, {"r": 3}])
        assert await engine._should_evolve(state) is True

    @pytest.mark.asyncio
    async def test_boundary_more_than_3_steps(self, engine):
        state = make_state(tool_results=[{"r": i} for i in range(10)])
        assert await engine._should_evolve(state) is True

    @pytest.mark.asyncio
    async def test_empty_tool_results(self, engine):
        state = make_state(tool_results=[])
        assert await engine._should_evolve(state) is False
