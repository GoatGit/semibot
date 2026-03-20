"""Sandbox tests fixtures."""

import pytest
from unittest.mock import Mock, AsyncMock, MagicMock, patch
from datetime import datetime

from src.sandbox.models import SandboxConfig, SandboxStatus, ExecutionResult
from src.sandbox.policy import PolicyEngine


@pytest.fixture
def sandbox_config():
    """Create a default sandbox configuration."""
    return SandboxConfig(
        max_memory_mb=256,
        max_execution_time_seconds=30,
        max_cpu_cores=0.5,
        network_access=False,
        working_dir="/workspace",
        user="sandbox",
    )


@pytest.fixture
def mock_container():
    """Create a mock Docker container."""
    container = MagicMock()
    container.id = "test-container-123"
    container.status = "running"
    container.exec_run = MagicMock(return_value=MagicMock(
        exit_code=0,
        output=(b"Hello, World!", b"")
    ))
    container.stop = MagicMock()
    container.remove = MagicMock()
    return container


@pytest.fixture
def mock_docker_client():
    """Create a mock Docker client."""
    with patch("docker.from_env") as mock_docker:
        client = MagicMock()
        client.containers = MagicMock()
        client.images = MagicMock()
        mock_docker.return_value = client
        yield client


@pytest.fixture
def policy_engine():
    """Create a default policy engine."""
    return PolicyEngine()


@pytest.fixture
def execution_result():
    """Create a sample execution result."""
    return ExecutionResult(
        stdout="Hello, World!",
        stderr="",
        exit_code=0,
        execution_time_ms=100,
        timed_out=False,
    )
