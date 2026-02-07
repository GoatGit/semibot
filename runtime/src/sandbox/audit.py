"""Audit Logger - Security audit logging for sandbox executions."""

import json
import logging
from datetime import datetime
from pathlib import Path
from typing import Any

from src.sandbox.models import AuditLogEntry, ExecutionResult

logger = logging.getLogger(__name__)


class AuditLogger:
    """
    Audit logger for sandbox executions.

    Records all sandbox operations for security auditing and compliance.
    Supports multiple output backends (file, database, external service).

    Example:
        ```python
        audit = AuditLogger(log_dir="/var/log/sandbox")

        audit.log_execution(
            session_id="sess_123",
            agent_id="agent_456",
            org_id="org_789",
            sandbox_id="sandbox_abc",
            tool="code_run",
            result=execution_result,
        )

        # Query logs
        logs = audit.query(session_id="sess_123")
        ```
    """

    def __init__(
        self,
        log_dir: str | None = None,
        max_entries: int = 10000,
        enable_file_logging: bool = True,
    ):
        """
        Initialize AuditLogger.

        Args:
            log_dir: Directory for audit log files
            max_entries: Maximum in-memory log entries
            enable_file_logging: Whether to write logs to files
        """
        self.log_dir = Path(log_dir) if log_dir else None
        self.max_entries = max_entries
        self.enable_file_logging = enable_file_logging
        self.entries: list[AuditLogEntry] = []

        if self.log_dir and self.enable_file_logging:
            self.log_dir.mkdir(parents=True, exist_ok=True)

    def log_execution(
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
        metadata: dict[str, Any] | None = None,
    ) -> AuditLogEntry:
        """
        Log a sandbox execution.

        Args:
            session_id: Session identifier
            agent_id: Agent identifier
            org_id: Organization identifier
            sandbox_id: Sandbox container identifier
            tool: Tool name (code_run, shell_exec, etc.)
            result: Execution result
            language: Programming language (for code_run)
            code_hash: Hash of executed code
            command: Shell command (for shell_exec)
            metadata: Additional metadata

        Returns:
            Created audit log entry
        """
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
            cpu_time_ms=result.cpu_time_ms,
            result="success" if result.success else "failed",
            error=result.error,
        )

        # Add to in-memory store
        self._add_entry(entry)

        # Write to file if enabled
        if self.enable_file_logging and self.log_dir:
            self._write_to_file(entry)

        # Log to standard logger
        log_data = entry.to_dict()
        if result.success:
            logger.info(f"Sandbox execution completed: {json.dumps(log_data)}")
        else:
            logger.warning(f"Sandbox execution failed: {json.dumps(log_data)}")

        return entry

    def log_policy_violation(
        self,
        session_id: str,
        agent_id: str,
        org_id: str,
        tool: str,
        violation_type: str,
        details: str,
        command: str | None = None,
        code_hash: str | None = None,
    ) -> AuditLogEntry:
        """
        Log a policy violation.

        Args:
            session_id: Session identifier
            agent_id: Agent identifier
            org_id: Organization identifier
            tool: Tool that was attempted
            violation_type: Type of violation
            details: Violation details
            command: Attempted command
            code_hash: Hash of attempted code

        Returns:
            Created audit log entry
        """
        entry = AuditLogEntry(
            timestamp=datetime.now(),
            event_type="policy_violation",
            session_id=session_id,
            agent_id=agent_id,
            org_id=org_id,
            sandbox_id="",
            tool=tool,
            code_hash=code_hash,
            command=command,
            result="blocked",
            error=f"{violation_type}: {details}",
        )

        self._add_entry(entry)

        if self.enable_file_logging and self.log_dir:
            self._write_to_file(entry)

        logger.warning(f"Policy violation: {json.dumps(entry.to_dict())}")

        return entry

    def _add_entry(self, entry: AuditLogEntry) -> None:
        """Add entry to in-memory store with size limit."""
        self.entries.append(entry)

        # Trim if over limit
        if len(self.entries) > self.max_entries:
            trim_count = len(self.entries) - self.max_entries
            self.entries = self.entries[trim_count:]
            logger.debug(f"Trimmed {trim_count} old audit entries")

    def _write_to_file(self, entry: AuditLogEntry) -> None:
        """Write entry to audit log file."""
        if not self.log_dir:
            return

        # Use daily rotation
        date_str = entry.timestamp.strftime("%Y-%m-%d")
        log_file = self.log_dir / f"sandbox-audit-{date_str}.jsonl"

        try:
            with open(log_file, "a") as f:
                f.write(json.dumps(entry.to_dict()) + "\n")
        except Exception as e:
            logger.error(f"Failed to write audit log: {e}")

    def query(
        self,
        session_id: str | None = None,
        agent_id: str | None = None,
        org_id: str | None = None,
        tool: str | None = None,
        event_type: str | None = None,
        start_time: datetime | None = None,
        end_time: datetime | None = None,
        limit: int = 100,
    ) -> list[AuditLogEntry]:
        """
        Query audit logs with filters.

        Args:
            session_id: Filter by session
            agent_id: Filter by agent
            org_id: Filter by organization
            tool: Filter by tool name
            event_type: Filter by event type
            start_time: Filter by start time
            end_time: Filter by end time
            limit: Maximum results to return

        Returns:
            List of matching audit entries
        """
        results = self.entries

        if session_id:
            results = [e for e in results if e.session_id == session_id]
        if agent_id:
            results = [e for e in results if e.agent_id == agent_id]
        if org_id:
            results = [e for e in results if e.org_id == org_id]
        if tool:
            results = [e for e in results if e.tool == tool]
        if event_type:
            results = [e for e in results if e.event_type == event_type]
        if start_time:
            results = [e for e in results if e.timestamp >= start_time]
        if end_time:
            results = [e for e in results if e.timestamp <= end_time]

        return results[-limit:]

    def get_stats(
        self,
        org_id: str | None = None,
        hours: int = 24,
    ) -> dict[str, Any]:
        """
        Get execution statistics.

        Args:
            org_id: Filter by organization
            hours: Time window in hours

        Returns:
            Statistics dictionary
        """
        cutoff = datetime.now().timestamp() - (hours * 3600)
        entries = [
            e for e in self.entries
            if e.timestamp.timestamp() >= cutoff
        ]

        if org_id:
            entries = [e for e in entries if e.org_id == org_id]

        total = len(entries)
        successful = len([e for e in entries if e.result == "success"])
        failed = len([e for e in entries if e.result == "failed"])
        blocked = len([e for e in entries if e.result == "blocked"])

        tools_usage: dict[str, int] = {}
        for entry in entries:
            tools_usage[entry.tool] = tools_usage.get(entry.tool, 0) + 1

        avg_execution_time = 0.0
        if entries:
            avg_execution_time = sum(e.execution_time_ms for e in entries) / len(entries)

        return {
            "total_executions": total,
            "successful": successful,
            "failed": failed,
            "blocked": blocked,
            "success_rate": successful / total if total > 0 else 0,
            "tools_usage": tools_usage,
            "avg_execution_time_ms": avg_execution_time,
            "time_window_hours": hours,
        }

    def export(
        self,
        output_file: str,
        start_time: datetime | None = None,
        end_time: datetime | None = None,
    ) -> int:
        """
        Export audit logs to file.

        Args:
            output_file: Output file path
            start_time: Export start time
            end_time: Export end time

        Returns:
            Number of entries exported
        """
        entries = self.entries

        if start_time:
            entries = [e for e in entries if e.timestamp >= start_time]
        if end_time:
            entries = [e for e in entries if e.timestamp <= end_time]

        with open(output_file, "w") as f:
            for entry in entries:
                f.write(json.dumps(entry.to_dict()) + "\n")

        logger.info(f"Exported {len(entries)} audit entries to {output_file}")
        return len(entries)
