"""EvolutionEngine Redis cooldown & rate-limit tests."""

import pytest
from unittest.mock import AsyncMock, Mock, patch
from src.evolution.engine import (
    EvolutionEngine,
    EVOLUTION_DEFAULT_COOLDOWN_WINDOW,
    EVOLUTION_DEFAULT_MAX_PER_WINDOW,
)


@pytest.fixture
def redis_mock():
    r = AsyncMock()
    r.eval = AsyncMock(return_value=1)
    r.zcount = AsyncMock(return_value=0)
    return r


@pytest.fixture
def engine_with_redis(redis_mock):
    return EvolutionEngine(
        llm=Mock(), memory_system=Mock(),
        skill_registry=Mock(), db_pool=Mock(),
        redis_client=redis_mock,
    )


@pytest.fixture
def engine_no_redis():
    return EvolutionEngine(
        llm=Mock(), memory_system=Mock(),
        skill_registry=Mock(), db_pool=Mock(),
        redis_client=None,
    )


class TestCheckCooldown:
    """_check_cooldown 冷却期检查"""

    @pytest.mark.asyncio
    async def test_allowed_when_lua_returns_1(self, engine_with_redis, redis_mock):
        redis_mock.eval = AsyncMock(return_value=1)
        result = await engine_with_redis._check_cooldown("agent-1", {})
        assert result is True

    @pytest.mark.asyncio
    async def test_blocked_when_lua_returns_0(self, engine_with_redis, redis_mock):
        redis_mock.eval = AsyncMock(return_value=0)
        result = await engine_with_redis._check_cooldown("agent-1", {})
        assert result is False

    @pytest.mark.asyncio
    async def test_uses_config_window_and_max(self, engine_with_redis, redis_mock):
        config = {"cooldown_window": 7200, "max_per_window": 10}
        await engine_with_redis._check_cooldown("agent-1", config)

        call_args = redis_mock.eval.call_args
        # eval(script, 1, key, now, window, max_count, entry_id)
        # positional: [0]=script, [1]=1, [2]=key, [3]=now, [4]=window, [5]=max_count, [6]=entry_id
        assert call_args[0][4] == "7200"
        assert call_args[0][5] == "10"

    @pytest.mark.asyncio
    async def test_uses_default_config(self, engine_with_redis, redis_mock):
        await engine_with_redis._check_cooldown("agent-1", {})

        call_args = redis_mock.eval.call_args
        assert call_args[0][4] == str(EVOLUTION_DEFAULT_COOLDOWN_WINDOW)
        assert call_args[0][5] == str(EVOLUTION_DEFAULT_MAX_PER_WINDOW)

    @pytest.mark.asyncio
    async def test_redis_key_contains_agent_id(self, engine_with_redis, redis_mock):
        await engine_with_redis._check_cooldown("agent-xyz", {})

        call_args = redis_mock.eval.call_args
        # KEYS[1] = key
        assert call_args[0][2] == "evolution:cooldown:agent-xyz"

    @pytest.mark.asyncio
    async def test_graceful_degradation_on_redis_error(self, engine_with_redis, redis_mock):
        redis_mock.eval = AsyncMock(side_effect=Exception("connection lost"))
        result = await engine_with_redis._check_cooldown("agent-1", {})
        assert result is True  # 降级为允许

    @pytest.mark.asyncio
    async def test_graceful_degradation_when_no_redis(self, engine_no_redis):
        result = await engine_no_redis._check_cooldown("agent-1", {})
        assert result is True  # 无 Redis 时降级为允许


class TestCheckRateLimit:
    """_check_rate_limit 频率限制检查"""

    @pytest.mark.asyncio
    async def test_allowed_when_count_below_max(self, engine_with_redis, redis_mock):
        redis_mock.zcount = AsyncMock(return_value=2)
        result = await engine_with_redis._check_rate_limit("agent-1", {"max_per_window": 5})
        assert result is True

    @pytest.mark.asyncio
    async def test_blocked_when_count_at_max(self, engine_with_redis, redis_mock):
        redis_mock.zcount = AsyncMock(return_value=5)
        result = await engine_with_redis._check_rate_limit("agent-1", {"max_per_window": 5})
        assert result is False

    @pytest.mark.asyncio
    async def test_blocked_when_count_exceeds_max(self, engine_with_redis, redis_mock):
        redis_mock.zcount = AsyncMock(return_value=10)
        result = await engine_with_redis._check_rate_limit("agent-1", {"max_per_window": 5})
        assert result is False

    @pytest.mark.asyncio
    async def test_uses_correct_redis_key(self, engine_with_redis, redis_mock):
        await engine_with_redis._check_rate_limit("agent-abc", {})

        call_args = redis_mock.zcount.call_args
        assert call_args[0][0] == "evolution:cooldown:agent-abc"

    @pytest.mark.asyncio
    async def test_uses_default_config(self, engine_with_redis, redis_mock):
        redis_mock.zcount = AsyncMock(return_value=0)
        result = await engine_with_redis._check_rate_limit("agent-1", {})
        assert result is True
        redis_mock.zcount.assert_called_once()

    @pytest.mark.asyncio
    async def test_graceful_degradation_on_redis_error(self, engine_with_redis, redis_mock):
        redis_mock.zcount = AsyncMock(side_effect=Exception("timeout"))
        result = await engine_with_redis._check_rate_limit("agent-1", {})
        assert result is True  # 降级为允许

    @pytest.mark.asyncio
    async def test_graceful_degradation_when_no_redis(self, engine_no_redis):
        result = await engine_no_redis._check_rate_limit("agent-1", {})
        assert result is True  # 无 Redis 时降级为允许

    @pytest.mark.asyncio
    async def test_boundary_count_one_below_max(self, engine_with_redis, redis_mock):
        redis_mock.zcount = AsyncMock(return_value=4)
        result = await engine_with_redis._check_rate_limit("agent-1", {"max_per_window": 5})
        assert result is True

    @pytest.mark.asyncio
    async def test_zero_count_allowed(self, engine_with_redis, redis_mock):
        redis_mock.zcount = AsyncMock(return_value=0)
        result = await engine_with_redis._check_rate_limit("agent-1", {"max_per_window": 5})
        assert result is True
