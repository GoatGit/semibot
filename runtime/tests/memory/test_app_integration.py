"""Unit tests for Memory System integration in app.py and routes.py.

These tests verify:
- MemorySystem initialization with graceful degradation
- Memory system shutdown
- Health endpoint memory status
- Context injection of memory_system
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest


# ---------------------------------------------------------------------------
# Tests for _create_memory_system
# ---------------------------------------------------------------------------

class TestCreateMemorySystem:
    """Tests for _create_memory_system in app.py."""

    @pytest.mark.asyncio
    async def test_returns_none_when_no_env_vars(self):
        """Memory system is None when REDIS_URL and DATABASE_URL are not set."""
        from src.server.app import _create_memory_system

        def fake_getenv(key, default=None):
            # Return None for all memory-related env vars
            return default

        with patch("src.server.app.os.getenv", side_effect=fake_getenv):
            result = await _create_memory_system()
            assert result is None

    @pytest.mark.asyncio
    async def test_returns_none_when_redis_fails(self):
        """Memory system is None when Redis connection fails and no DATABASE_URL."""
        from src.server.app import _create_memory_system

        def fake_getenv(key, default=None):
            return {"REDIS_URL": "redis://bad-host:6379"}.get(key, default)

        mock_st = AsyncMock()
        mock_st.health_check = AsyncMock(side_effect=Exception("Connection refused"))

        with patch("src.server.app.os.getenv", side_effect=fake_getenv), \
             patch("src.memory.ShortTermMemory", return_value=mock_st):
            result = await _create_memory_system()
            assert result is None

    @pytest.mark.asyncio
    async def test_creates_short_term_only(self):
        """Memory system with only short-term when only REDIS_URL is set."""
        from src.server.app import _create_memory_system

        def fake_getenv(key, default=None):
            return {"REDIS_URL": "redis://localhost:6379"}.get(key, default)

        mock_st = AsyncMock()
        mock_st.health_check = AsyncMock(return_value=True)

        with patch("src.server.app.os.getenv", side_effect=fake_getenv), \
             patch("src.memory.ShortTermMemory", return_value=mock_st):
            result = await _create_memory_system()

            assert result is not None
            assert result.short_term is not None
            assert result.long_term is None

    @pytest.mark.asyncio
    async def test_graceful_degradation_all_backends_fail(self):
        """Runtime starts even when all memory backends fail."""
        from src.server.app import _create_memory_system

        def fake_getenv(key, default=None):
            env = {
                "REDIS_URL": "redis://bad:6379",
                "DATABASE_URL": "postgresql://bad:5432/db",
                "OPENAI_API_KEY": "sk-test",
            }
            return env.get(key, default)

        mock_st = AsyncMock()
        mock_st.health_check = AsyncMock(side_effect=Exception("Redis down"))
        mock_lt = AsyncMock()
        mock_lt.health_check = AsyncMock(side_effect=Exception("PG down"))

        with patch("src.server.app.os.getenv", side_effect=fake_getenv), \
             patch("src.memory.ShortTermMemory", return_value=mock_st), \
             patch("src.memory.LongTermMemory", return_value=mock_lt), \
             patch("src.memory.OpenAIEmbeddingProvider"), \
             patch("src.memory.EmbeddingService", return_value=MagicMock()):
            result = await _create_memory_system()
            assert result is None

    @pytest.mark.asyncio
    async def test_creates_both_backends(self):
        """Memory system with both backends when all env vars are set."""
        from src.server.app import _create_memory_system

        def fake_getenv(key, default=None):
            env = {
                "REDIS_URL": "redis://localhost:6379",
                "DATABASE_URL": "postgresql://localhost:5432/db",
                "OPENAI_API_KEY": "sk-test",
            }
            return env.get(key, default)

        mock_st = AsyncMock()
        mock_st.health_check = AsyncMock(return_value=True)
        mock_lt = AsyncMock()
        mock_lt.health_check = AsyncMock(return_value=True)

        with patch("src.server.app.os.getenv", side_effect=fake_getenv), \
             patch("src.memory.ShortTermMemory", return_value=mock_st), \
             patch("src.memory.LongTermMemory", return_value=mock_lt), \
             patch("src.memory.OpenAIEmbeddingProvider"), \
             patch("src.memory.EmbeddingService", return_value=MagicMock()):
            result = await _create_memory_system()

            assert result is not None
            assert result.short_term is not None
            assert result.long_term is not None


# ---------------------------------------------------------------------------
# Tests for _shutdown_memory_system
# ---------------------------------------------------------------------------

class TestShutdownMemorySystem:
    """Tests for _shutdown_memory_system in app.py."""

    @pytest.mark.asyncio
    async def test_shutdown_none(self):
        """Shutdown with None memory system is a no-op."""
        from src.server.app import _shutdown_memory_system
        await _shutdown_memory_system(None)  # Should not raise

    @pytest.mark.asyncio
    async def test_shutdown_closes_connections(self):
        """Shutdown closes both short-term and long-term connections."""
        from src.server.app import _shutdown_memory_system

        mock_memory = MagicMock()
        mock_memory.short_term = AsyncMock()
        mock_memory.short_term.close = AsyncMock()
        mock_memory.long_term = AsyncMock()
        mock_memory.long_term.close = AsyncMock()

        await _shutdown_memory_system(mock_memory)

        mock_memory.short_term.close.assert_called_once()
        mock_memory.long_term.close.assert_called_once()

    @pytest.mark.asyncio
    async def test_shutdown_handles_errors(self):
        """Shutdown handles errors gracefully without raising."""
        from src.server.app import _shutdown_memory_system

        mock_memory = MagicMock()
        mock_memory.short_term = AsyncMock()
        mock_memory.short_term.close = AsyncMock(side_effect=Exception("close error"))
        mock_memory.long_term = None

        await _shutdown_memory_system(mock_memory)  # Should not raise


# ---------------------------------------------------------------------------
# Tests for /health endpoint memory status
# ---------------------------------------------------------------------------

class TestHealthEndpointMemory:
    """Tests for /health endpoint memory status.

    We use a custom lifespan that skips real initialization to avoid
    connecting to real services. The mock memory_system is set in the
    custom lifespan.
    """

    @staticmethod
    def _make_test_app(memory_system=None):
        """Create a test app with a no-op lifespan and injected memory_system."""
        from contextlib import asynccontextmanager
        from fastapi import FastAPI
        from src.server.routes import router

        @asynccontextmanager
        async def test_lifespan(app: FastAPI):
            app.state.memory_system = memory_system
            yield

        app = FastAPI(lifespan=test_lifespan)
        app.include_router(router)
        return app

    def test_health_without_memory(self):
        """Health check returns no memory field when memory is None."""
        from fastapi.testclient import TestClient

        app = self._make_test_app(memory_system=None)
        with TestClient(app) as client:
            response = client.get("/health")
            assert response.status_code == 200
            data = response.json()
            assert data["status"] == "healthy"
            assert data["memory"] is None

    def test_health_with_memory_both_healthy(self):
        """Health check includes memory status when both backends are healthy."""
        from fastapi.testclient import TestClient

        mock_memory = MagicMock()
        mock_memory.short_term = AsyncMock()
        mock_memory.short_term.health_check = AsyncMock(return_value=True)
        mock_memory.long_term = AsyncMock()
        mock_memory.long_term.health_check = AsyncMock(return_value=True)

        app = self._make_test_app(memory_system=mock_memory)
        with TestClient(app) as client:
            response = client.get("/health")
            assert response.status_code == 200
            data = response.json()
            assert data["status"] == "healthy"
            assert data["memory"]["short_term"] is True
            assert data["memory"]["long_term"] is True

    def test_health_with_partial_memory(self):
        """Health check shows partial memory status (short-term only)."""
        from fastapi.testclient import TestClient

        mock_memory = MagicMock()
        mock_memory.short_term = AsyncMock()
        mock_memory.short_term.health_check = AsyncMock(return_value=True)
        mock_memory.long_term = None

        app = self._make_test_app(memory_system=mock_memory)
        with TestClient(app) as client:
            response = client.get("/health")
            data = response.json()
            assert data["memory"]["short_term"] is True
            assert data["memory"]["long_term"] is None

    def test_health_with_unhealthy_backend(self):
        """Health check shows False for unhealthy backend."""
        from fastapi.testclient import TestClient

        mock_memory = MagicMock()
        mock_memory.short_term = AsyncMock()
        mock_memory.short_term.health_check = AsyncMock(side_effect=Exception("down"))
        mock_memory.long_term = None

        app = self._make_test_app(memory_system=mock_memory)
        with TestClient(app) as client:
            response = client.get("/health")
            data = response.json()
            assert data["status"] == "healthy"
            assert data["memory"]["short_term"] is False


# ---------------------------------------------------------------------------
# Tests for context injection
# ---------------------------------------------------------------------------

class TestContextInjection:
    """Tests for memory_system injection into orchestrator context."""

    def test_get_memory_system_returns_none_when_not_set(self):
        """_get_memory_system returns None when not in app state."""
        from src.server.routes import _get_memory_system

        mock_request = MagicMock()
        mock_request.app.state = MagicMock(spec=[])  # No attributes
        result = _get_memory_system(mock_request)
        assert result is None

    def test_get_memory_system_returns_instance(self):
        """_get_memory_system returns the memory system from app state."""
        from src.server.routes import _get_memory_system

        mock_memory = MagicMock()
        mock_request = MagicMock()
        mock_request.app.state.memory_system = mock_memory
        result = _get_memory_system(mock_request)
        assert result is mock_memory
