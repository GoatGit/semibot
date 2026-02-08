"""Sandbox Manager - Core sandbox orchestration and execution."""

import asyncio
import hashlib
import os
import tempfile
import time
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any

import docker
from docker.errors import ContainerError, ImageNotFound, APIError
from docker.models.containers import Container

from src.sandbox.models import (
    AuditLogEntry,
    ExecutionResult,
    SandboxConfig,
    SandboxStatus,
)
from src.sandbox.policy import PolicyEngine
from src.sandbox.exceptions import (
    SandboxContainerError,
    SandboxError,
    SandboxResourceError,
    SandboxTimeoutError,
)
from src.utils.logging import get_logger

logger = get_logger(__name__)


class Sandbox:
    """
    Individual sandbox container instance.

    Manages a single Docker container for isolated code execution.
    """

    def __init__(
        self,
        sandbox_id: str,
        container: Container,
        config: SandboxConfig,
        workspace_path: str,
    ):
        self.sandbox_id = sandbox_id
        self.container = container
        self.config = config
        self.workspace_path = workspace_path
        self.status = SandboxStatus.IDLE
        self.created_at = datetime.now()
        self.last_used_at = datetime.now()
        self.execution_count = 0

    async def execute(
        self,
        command: str,
        timeout: int | None = None,
        env: dict[str, str] | None = None,
    ) -> ExecutionResult:
        """
        Execute command in sandbox.

        Args:
            command: Command to execute
            timeout: Execution timeout in seconds
            env: Environment variables

        Returns:
            ExecutionResult with stdout, stderr, exit code
        """
        timeout = timeout or self.config.max_execution_time_seconds
        self.status = SandboxStatus.BUSY
        self.last_used_at = datetime.now()
        start_time = time.time()

        try:
            # Execute command in container
            exec_result = await asyncio.wait_for(
                asyncio.to_thread(
                    self.container.exec_run,
                    command,
                    workdir=self.config.working_dir,
                    environment=env or {},
                    user=self.config.user,
                    demux=True,
                ),
                timeout=timeout,
            )

            execution_time_ms = int((time.time() - start_time) * 1000)
            stdout, stderr = exec_result.output

            self.execution_count += 1
            self.status = SandboxStatus.IDLE

            return ExecutionResult(
                success=exec_result.exit_code == 0,
                exit_code=exec_result.exit_code,
                stdout=(stdout or b"").decode("utf-8", errors="replace"),
                stderr=(stderr or b"").decode("utf-8", errors="replace"),
                execution_time_ms=execution_time_ms,
            )

        except asyncio.TimeoutError:
            self.status = SandboxStatus.IDLE
            # Kill any running process
            try:
                self.container.exec_run("pkill -9 -u sandbox", user="root")
            except Exception:
                pass
            raise SandboxTimeoutError(timeout)

        except Exception as e:
            self.status = SandboxStatus.ERROR
            logger.error(f"Sandbox execution error: {e}")
            raise SandboxError(f"Execution failed: {str(e)}")

    async def cleanup(self) -> None:
        """Clean up workspace after execution."""
        try:
            # Clear workspace
            self.container.exec_run(
                f"find {self.config.working_dir} -mindepth 1 -delete",
                user="root",
            )
        except Exception as e:
            logger.warning(f"Workspace cleanup failed: {e}")

    def get_stats(self) -> dict[str, Any]:
        """Get container resource usage stats."""
        try:
            stats = self.container.stats(stream=False)
            memory_usage = stats.get("memory_stats", {}).get("usage", 0)
            cpu_stats = stats.get("cpu_stats", {})

            return {
                "memory_used_mb": memory_usage / (1024 * 1024),
                "cpu_percent": self._calculate_cpu_percent(stats),
            }
        except Exception:
            return {"memory_used_mb": 0, "cpu_percent": 0}

    def _calculate_cpu_percent(self, stats: dict) -> float:
        """Calculate CPU usage percentage."""
        try:
            cpu_delta = (
                stats["cpu_stats"]["cpu_usage"]["total_usage"]
                - stats["precpu_stats"]["cpu_usage"]["total_usage"]
            )
            system_delta = (
                stats["cpu_stats"]["system_cpu_usage"]
                - stats["precpu_stats"]["system_cpu_usage"]
            )
            if system_delta > 0:
                return (cpu_delta / system_delta) * 100
        except (KeyError, ZeroDivisionError):
            pass
        return 0.0


class SandboxPool:
    """
    Pool of sandbox containers for reuse.

    Maintains a pool of pre-warmed containers to reduce
    execution latency.
    """

    def __init__(
        self,
        docker_client: docker.DockerClient,
        pool_size: int = 5,
        config: SandboxConfig | None = None,
    ):
        self.docker_client = docker_client
        self.pool_size = pool_size
        self.config = config or SandboxConfig()
        self.sandboxes: dict[str, Sandbox] = {}
        self.lock = asyncio.Lock()

    async def initialize(self) -> None:
        """Initialize the sandbox pool with pre-warmed containers."""
        logger.info(f"Initializing sandbox pool with {self.pool_size} containers")

        # Ensure image exists
        await self._ensure_image()

        # Create initial containers
        tasks = [self._create_sandbox() for _ in range(self.pool_size)]
        sandboxes = await asyncio.gather(*tasks, return_exceptions=True)

        for sandbox in sandboxes:
            if isinstance(sandbox, Sandbox):
                self.sandboxes[sandbox.sandbox_id] = sandbox
            elif isinstance(sandbox, Exception):
                logger.error(f"Failed to create sandbox: {sandbox}")

        logger.info(f"Sandbox pool initialized with {len(self.sandboxes)} containers")

    async def _ensure_image(self) -> None:
        """Ensure sandbox Docker image exists."""
        try:
            self.docker_client.images.get(self.config.docker_image)
        except ImageNotFound:
            logger.info(f"Pulling sandbox image: {self.config.docker_image}")
            try:
                await asyncio.to_thread(
                    self.docker_client.images.pull, self.config.docker_image
                )
            except APIError as e:
                # If pull fails, try to build locally
                logger.warning(f"Failed to pull image: {e}, will use python:3.11-slim")
                self.config.docker_image = "python:3.11-slim"

    async def _create_sandbox(self) -> Sandbox:
        """Create a new sandbox container."""
        sandbox_id = f"sandbox-{uuid.uuid4().hex[:8]}"

        # Create temporary workspace
        workspace_path = tempfile.mkdtemp(prefix=f"{sandbox_id}-")

        # Container configuration
        container_config = {
            "image": self.config.docker_image,
            "name": sandbox_id,
            "detach": True,
            "tty": True,
            "user": "1000:1000",  # Non-root user
            "working_dir": self.config.working_dir,
            "mem_limit": f"{self.config.max_memory_mb}m",
            "cpu_period": 100000,
            "cpu_quota": int(self.config.max_cpu_cores * 100000),
            "network_mode": "none" if not self.config.network_access else "bridge",
            "read_only": False,
            "security_opt": ["no-new-privileges:true"],
            "volumes": {
                workspace_path: {"bind": self.config.working_dir, "mode": "rw"}
            },
            "command": "tail -f /dev/null",  # Keep container running
        }

        # Add seccomp profile if specified
        if self.config.seccomp_profile:
            container_config["security_opt"].append(
                f"seccomp={self.config.seccomp_profile}"
            )

        try:
            container = await asyncio.to_thread(
                self.docker_client.containers.run, **container_config
            )

            return Sandbox(
                sandbox_id=sandbox_id,
                container=container,
                config=self.config,
                workspace_path=workspace_path,
            )

        except Exception as e:
            logger.error(f"Failed to create sandbox container: {e}")
            raise SandboxContainerError("create", None, str(e))

    async def acquire(self) -> Sandbox:
        """
        Acquire an idle sandbox from the pool.

        Returns:
            An idle Sandbox instance

        Raises:
            SandboxResourceError: If no sandboxes available
        """
        async with self.lock:
            # Find an idle sandbox
            for sandbox in self.sandboxes.values():
                if sandbox.status == SandboxStatus.IDLE:
                    sandbox.status = SandboxStatus.BUSY
                    return sandbox

            # No idle sandbox, create a new one if under limit
            if len(self.sandboxes) < self.pool_size * 2:  # Allow 2x overflow
                sandbox = await self._create_sandbox()
                self.sandboxes[sandbox.sandbox_id] = sandbox
                sandbox.status = SandboxStatus.BUSY
                return sandbox

            raise SandboxResourceError(
                "sandboxes",
                str(self.pool_size),
                str(len([s for s in self.sandboxes.values() if s.status == SandboxStatus.BUSY])),
            )

    async def release(self, sandbox: Sandbox) -> None:
        """
        Release a sandbox back to the pool.

        Args:
            sandbox: The sandbox to release
        """
        # Clean up workspace
        await sandbox.cleanup()
        sandbox.status = SandboxStatus.IDLE

        # Remove excess sandboxes
        async with self.lock:
            if len(self.sandboxes) > self.pool_size:
                # Remove oldest idle sandbox
                idle_sandboxes = [
                    s for s in self.sandboxes.values()
                    if s.status == SandboxStatus.IDLE and s.sandbox_id != sandbox.sandbox_id
                ]
                if idle_sandboxes:
                    oldest = min(idle_sandboxes, key=lambda s: s.last_used_at)
                    await self._destroy_sandbox(oldest)

    async def _destroy_sandbox(self, sandbox: Sandbox) -> None:
        """Destroy a sandbox container."""
        try:
            sandbox.container.stop(timeout=5)
            sandbox.container.remove(force=True)
            del self.sandboxes[sandbox.sandbox_id]

            # Clean up workspace directory
            if os.path.exists(sandbox.workspace_path):
                import shutil
                shutil.rmtree(sandbox.workspace_path, ignore_errors=True)

        except Exception as e:
            logger.error(f"Failed to destroy sandbox {sandbox.sandbox_id}: {e}")

    async def shutdown(self) -> None:
        """Shutdown all sandboxes in the pool."""
        logger.info("Shutting down sandbox pool")
        tasks = [self._destroy_sandbox(s) for s in list(self.sandboxes.values())]
        await asyncio.gather(*tasks, return_exceptions=True)
        logger.info("Sandbox pool shutdown complete")


class SandboxManager:
    """
    Main sandbox manager for AI Agent tool execution.

    Provides high-level API for executing code and commands
    in isolated sandbox containers.

    Example:
        ```python
        manager = SandboxManager(pool_size=5)
        await manager.initialize()

        # Execute Python code
        result = await manager.execute_code(
            language="python",
            code="print('Hello!')",
            timeout=30,
        )

        # Execute shell command
        result = await manager.execute_shell(
            command="ls -la",
            timeout=10,
        )

        await manager.shutdown()
        ```
    """

    LANGUAGE_COMMANDS = {
        "python": "python3 -c",
        "python3": "python3 -c",
        "javascript": "node -e",
        "node": "node -e",
        "bash": "bash -c",
        "sh": "sh -c",
    }

    def __init__(
        self,
        docker_url: str = "unix:///var/run/docker.sock",
        pool_size: int = 5,
        policy_file: str | None = None,
        config: SandboxConfig | None = None,
    ):
        """
        Initialize SandboxManager.

        Args:
            docker_url: Docker daemon URL
            pool_size: Number of pre-warmed containers
            policy_file: Path to policy YAML file
            config: Default sandbox configuration
        """
        self.docker_client = docker.DockerClient(base_url=docker_url)
        self.config = config or SandboxConfig()
        self.policy = PolicyEngine(policy_file=policy_file, default_config=self.config)
        self.pool = SandboxPool(self.docker_client, pool_size, self.config)
        self.audit_logs: list[AuditLogEntry] = []
        self._initialized = False

    async def initialize(self) -> None:
        """Initialize the sandbox manager and pool."""
        if self._initialized:
            return
        await self.pool.initialize()
        self._initialized = True
        logger.info("SandboxManager initialized")

    async def shutdown(self) -> None:
        """Shutdown the sandbox manager."""
        await self.pool.shutdown()
        self.docker_client.close()
        self._initialized = False
        logger.info("SandboxManager shutdown")

    async def execute_code(
        self,
        language: str,
        code: str,
        timeout: int | None = None,
        files: dict[str, bytes] | None = None,
        session_id: str = "",
        agent_id: str = "",
        org_id: str = "",
    ) -> ExecutionResult:
        """
        Execute code in sandbox.

        Args:
            language: Programming language (python, javascript, bash)
            code: Code to execute
            timeout: Execution timeout in seconds
            files: Additional files to include in workspace
            session_id: Session ID for audit logging
            agent_id: Agent ID for audit logging
            org_id: Organization ID for audit logging

        Returns:
            ExecutionResult with output and status
        """
        if not self._initialized:
            await self.initialize()

        # Check permission
        self.policy.check_permission("code_run", code=code)

        # Get language command
        if language.lower() not in self.LANGUAGE_COMMANDS:
            raise SandboxError(f"Unsupported language: {language}")

        cmd_prefix = self.LANGUAGE_COMMANDS[language.lower()]

        # Acquire sandbox
        sandbox = await self.pool.acquire()

        try:
            # Prepare workspace
            if files:
                await self._upload_files(sandbox, files)

            # Execute code
            # Escape single quotes in code
            escaped_code = code.replace("'", "'\\''")
            command = f"{cmd_prefix} '{escaped_code}'"

            result = await sandbox.execute(
                command=command,
                timeout=timeout or self.config.max_execution_time_seconds,
            )

            # Get resource stats
            stats = sandbox.get_stats()
            result.memory_used_mb = stats.get("memory_used_mb", 0)

            # Audit log
            self._log_execution(
                session_id=session_id,
                agent_id=agent_id,
                org_id=org_id,
                sandbox_id=sandbox.sandbox_id,
                tool="code_run",
                language=language,
                code_hash=self.policy.hash_code(code),
                result=result,
            )

            return result

        finally:
            await self.pool.release(sandbox)

    async def execute_shell(
        self,
        command: str,
        timeout: int | None = None,
        files: dict[str, bytes] | None = None,
        session_id: str = "",
        agent_id: str = "",
        org_id: str = "",
    ) -> ExecutionResult:
        """
        Execute shell command in sandbox.

        Args:
            command: Shell command to execute
            timeout: Execution timeout in seconds
            files: Additional files to include in workspace
            session_id: Session ID for audit logging
            agent_id: Agent ID for audit logging
            org_id: Organization ID for audit logging

        Returns:
            ExecutionResult with output and status
        """
        if not self._initialized:
            await self.initialize()

        # Check permission
        self.policy.check_permission("shell_exec", command=command)

        # Acquire sandbox
        sandbox = await self.pool.acquire()

        try:
            # Prepare workspace
            if files:
                await self._upload_files(sandbox, files)

            # Execute command
            result = await sandbox.execute(
                command=f"bash -c '{command}'",
                timeout=timeout or self.config.max_execution_time_seconds,
            )

            # Get resource stats
            stats = sandbox.get_stats()
            result.memory_used_mb = stats.get("memory_used_mb", 0)

            # Audit log
            self._log_execution(
                session_id=session_id,
                agent_id=agent_id,
                org_id=org_id,
                sandbox_id=sandbox.sandbox_id,
                tool="shell_exec",
                command=command,
                result=result,
            )

            return result

        finally:
            await self.pool.release(sandbox)

    async def execute_file(
        self,
        filepath: str,
        language: str | None = None,
        args: list[str] | None = None,
        timeout: int | None = None,
        files: dict[str, bytes] | None = None,
        session_id: str = "",
        agent_id: str = "",
        org_id: str = "",
    ) -> ExecutionResult:
        """
        Execute a file in sandbox.

        Args:
            filepath: Path to the file to execute (relative to workspace)
            language: Programming language (auto-detected if not specified)
            args: Command line arguments
            timeout: Execution timeout in seconds
            files: Files to include in workspace (must include the file to execute)
            session_id: Session ID for audit logging
            agent_id: Agent ID for audit logging
            org_id: Organization ID for audit logging

        Returns:
            ExecutionResult with output and status
        """
        if not self._initialized:
            await self.initialize()

        # Auto-detect language from extension
        if not language:
            ext = Path(filepath).suffix.lower()
            language_map = {
                ".py": "python",
                ".js": "javascript",
                ".sh": "bash",
            }
            language = language_map.get(ext, "bash")

        # Build command
        if language == "python":
            cmd = f"python3 {filepath}"
        elif language == "javascript":
            cmd = f"node {filepath}"
        else:
            cmd = f"bash {filepath}"

        if args:
            cmd += " " + " ".join(args)

        # Execute via shell
        return await self.execute_shell(
            command=cmd,
            timeout=timeout,
            files=files,
            session_id=session_id,
            agent_id=agent_id,
            org_id=org_id,
        )

    async def _upload_files(
        self, sandbox: Sandbox, files: dict[str, bytes]
    ) -> None:
        """Upload files to sandbox workspace."""
        import tarfile
        import io

        # Create tar archive
        tar_buffer = io.BytesIO()
        with tarfile.open(fileobj=tar_buffer, mode="w") as tar:
            for filename, content in files.items():
                file_data = io.BytesIO(content)
                tarinfo = tarfile.TarInfo(name=filename)
                tarinfo.size = len(content)
                tar.addfile(tarinfo, file_data)

        tar_buffer.seek(0)

        # Upload to container
        await asyncio.to_thread(
            sandbox.container.put_archive,
            sandbox.config.working_dir,
            tar_buffer.getvalue(),
        )

    def _log_execution(
        self,
        session_id: str,
        agent_id: str,
        org_id: str,
        sandbox_id: str,
        tool: str,
        result: ExecutionResult,
        language: str | None = None,
        code_hash: str | None = None,
        command: str | None = None,
    ) -> None:
        """Log execution for audit."""
        entry = AuditLogEntry(
            timestamp=datetime.now(),
            event_type="sandbox_execution",
            session_id=session_id,
            agent_id=agent_id,
            org_id=org_id,
            sandbox_id=sandbox_id,
            tool=tool,
            language=language,
            code_hash=code_hash,
            command=command,
            execution_time_ms=result.execution_time_ms,
            exit_code=result.exit_code,
            memory_used_mb=result.memory_used_mb,
            result="success" if result.success else "failed",
            error=result.error,
        )

        self.audit_logs.append(entry)
        logger.info(f"Sandbox execution: {entry.to_dict()}")

    def get_audit_logs(
        self,
        session_id: str | None = None,
        agent_id: str | None = None,
        limit: int = 100,
    ) -> list[AuditLogEntry]:
        """Get audit logs with optional filtering."""
        logs = self.audit_logs

        if session_id:
            logs = [l for l in logs if l.session_id == session_id]
        if agent_id:
            logs = [l for l in logs if l.agent_id == agent_id]

        return logs[-limit:]
