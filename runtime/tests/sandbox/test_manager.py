"""SandboxManager unit tests."""

import pytest
from unittest.mock import Mock, AsyncMock, MagicMock, patch
from datetime import datetime

from src.sandbox.manager import Sandbox, SandboxManager
from src.sandbox.models import SandboxConfig, SandboxStatus, ExecutionResult
from src.sandbox.exceptions import (
    SandboxError,
    SandboxContainerError,
    SandboxTimeoutError,
    SandboxResourceError,
)


class TestSandbox:
    """Sandbox instance tests."""

    @pytest.fixture
    def sandbox(self, mock_container, sandbox_config):
        """Create a Sandbox instance for testing."""
        return Sandbox(
            sandbox_id="test-sandbox-123",
            container=mock_container,
            config=sandbox_config,
            workspace_path="/tmp/sandbox-workspace",
        )

    def test_sandbox_initialization(self, sandbox):
        """Test sandbox initialization."""
        assert sandbox.sandbox_id == "test-sandbox-123"
        assert sandbox.status == SandboxStatus.IDLE
        assert sandbox.execution_count == 0
        assert sandbox.created_at is not None

    @pytest.mark.asyncio
    async def test_execute_success(self, sandbox, mock_container):
        """Test successful command execution."""
        mock_container.exec_run.return_value = MagicMock(
            exit_code=0,
            output=(b"Hello, World!", b"")
        )

        with patch("asyncio.to_thread", new_callable=AsyncMock) as mock_thread:
            mock_thread.return_value = MagicMock(
                exit_code=0,
                output=(b"Hello, World!", b"")
            )

            result = await sandbox.execute("echo 'Hello, World!'")

            assert result.exit_code == 0
            assert "Hello" in result.stdout
            assert sandbox.execution_count == 1
            assert sandbox.status == SandboxStatus.IDLE

    @pytest.mark.asyncio
    async def test_execute_timeout(self, sandbox):
        """Test command execution timeout."""
        with patch("asyncio.wait_for", side_effect=TimeoutError("Execution timed out")):
            with pytest.raises(SandboxTimeoutError):
                await sandbox.execute("while true; do :; done", timeout=1)


class TestSandboxManager:
    """SandboxManager tests."""

    @pytest.fixture
    def manager(self, mock_docker_client):
        """Create a SandboxManager instance."""
        with patch("docker.from_env", return_value=mock_docker_client):
            manager = SandboxManager()
            manager.client = mock_docker_client
            return manager

    @pytest.mark.asyncio
    async def test_create_sandbox_success(self, manager, mock_docker_client, mock_container):
        """Test successful sandbox creation."""
        mock_docker_client.containers.run.return_value = mock_container

        with patch.object(manager, "_create_container", new_callable=AsyncMock) as mock_create:
            mock_create.return_value = mock_container

            sandbox = await manager.create_sandbox()

            assert sandbox is not None
            assert sandbox.sandbox_id is not None

    @pytest.mark.asyncio
    async def test_create_sandbox_with_config(self, manager, mock_docker_client, mock_container):
        """Test sandbox creation with custom config."""
        config = SandboxConfig(
            max_memory_mb=512,
            max_execution_time_seconds=60,
            network_access=True,
        )
        mock_docker_client.containers.run.return_value = mock_container

        with patch.object(manager, "_create_container", new_callable=AsyncMock) as mock_create:
            mock_create.return_value = mock_container

            sandbox = await manager.create_sandbox(config=config)

            assert sandbox is not None

    @pytest.mark.asyncio
    async def test_destroy_sandbox_success(self, manager, mock_container):
        """Test successful sandbox destruction."""
        sandbox_id = "test-sandbox-123"
        manager.sandboxes[sandbox_id] = Sandbox(
            sandbox_id=sandbox_id,
            container=mock_container,
            config=SandboxConfig(),
            workspace_path="/tmp/test",
        )

        result = await manager.destroy_sandbox(sandbox_id)

        assert result is True
        assert sandbox_id not in manager.sandboxes

    @pytest.mark.asyncio
    async def test_destroy_sandbox_not_found(self, manager):
        """Test destroying non-existent sandbox."""
        result = await manager.destroy_sandbox("non-existent-id")

        assert result is False

    @pytest.mark.asyncio
    async def test_get_sandbox(self, manager, mock_container, sandbox_config):
        """Test getting an existing sandbox."""
        sandbox_id = "test-sandbox-123"
        sandbox = Sandbox(
            sandbox_id=sandbox_id,
            container=mock_container,
            config=sandbox_config,
            workspace_path="/tmp/test",
        )
        manager.sandboxes[sandbox_id] = sandbox

        result = manager.get_sandbox(sandbox_id)

        assert result is not None
        assert result.sandbox_id == sandbox_id

    def test_get_sandbox_not_found(self, manager):
        """Test getting non-existent sandbox."""
        result = manager.get_sandbox("non-existent-id")

        assert result is None

    @pytest.mark.asyncio
    async def test_cleanup_expired(self, manager, mock_container, sandbox_config):
        """Test cleaning up expired sandboxes."""
        # Create an expired sandbox
        from datetime import timedelta

        sandbox_id = "expired-sandbox"
        sandbox = Sandbox(
            sandbox_id=sandbox_id,
            container=mock_container,
            config=sandbox_config,
            workspace_path="/tmp/test",
        )
        sandbox.last_used_at = datetime.now() - timedelta(hours=2)
        manager.sandboxes[sandbox_id] = sandbox

        with patch.object(manager, "destroy_sandbox", new_callable=AsyncMock) as mock_destroy:
            mock_destroy.return_value = True

            count = await manager.cleanup_expired(max_idle_seconds=3600)

            assert count >= 0

    @pytest.mark.asyncio
    async def test_list_sandboxes(self, manager, mock_container, sandbox_config):
        """Test listing all sandboxes."""
        # Add some sandboxes
        for i in range(3):
            sandbox_id = f"sandbox-{i}"
            manager.sandboxes[sandbox_id] = Sandbox(
                sandbox_id=sandbox_id,
                container=mock_container,
                config=sandbox_config,
                workspace_path=f"/tmp/test-{i}",
            )

        sandboxes = manager.list_sandboxes()

        assert len(sandboxes) == 3

    @pytest.mark.asyncio
    async def test_execute_in_sandbox(self, manager, mock_container, sandbox_config):
        """Test executing command in sandbox."""
        sandbox_id = "test-sandbox"
        sandbox = Sandbox(
            sandbox_id=sandbox_id,
            container=mock_container,
            config=sandbox_config,
            workspace_path="/tmp/test",
        )
        manager.sandboxes[sandbox_id] = sandbox

        with patch.object(sandbox, "execute", new_callable=AsyncMock) as mock_execute:
            mock_execute.return_value = ExecutionResult(
                stdout="test output",
                stderr="",
                exit_code=0,
                execution_time_ms=50,
                timed_out=False,
            )

            result = await manager.execute(sandbox_id, "echo 'test'")

            assert result.exit_code == 0
            assert result.stdout == "test output"
