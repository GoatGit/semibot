"""Metrics collection for the runtime."""

import sqlite3
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
from uuid import uuid4

from src.utils.logging import get_logger

logger = get_logger(__name__)


@dataclass
class ExecutionMetrics:
    """Metrics for a single execution."""

    session_id: str
    agent_id: str

    # Timing metrics (milliseconds)
    total_duration_ms: int = 0
    plan_duration_ms: int = 0
    act_duration_ms: int = 0
    llm_latency_ms: int = 0
    tool_latency_ms: int = 0

    # Token metrics
    tokens_input: int = 0
    tokens_output: int = 0

    # Execution metrics
    iterations: int = 0
    tool_calls: int = 0
    skill_calls: int = 0
    errors: int = 0

    # Model info
    model: str = ""


class MetricsCollector:
    """
    Collects and manages execution metrics.

    Example:
        ```python
        collector = MetricsCollector("sess_123", "agent_456")

        collector.start_timer("plan")
        # ... planning logic ...
        collector.stop_timer("plan")

        collector.record_tool_call(150)
        collector.record_tokens(500, 100)

        metrics = collector.get_metrics()
        await collector.flush()
        ```
    """

    def __init__(self, session_id: str, agent_id: str):
        """
        Initialize the metrics collector.

        Args:
            session_id: Session identifier
            agent_id: Agent identifier
        """
        self.metrics = ExecutionMetrics(
            session_id=session_id,
            agent_id=agent_id,
        )
        self._timers: dict[str, float] = {}
        self._start_time: float = time.time()

    def start_timer(self, name: str) -> None:
        """
        Start a named timer.

        Args:
            name: Timer name (e.g., "plan", "act", "llm")
        """
        self._timers[name] = time.time()

    def stop_timer(self, name: str) -> int:
        """
        Stop a timer and record the duration.

        Args:
            name: Timer name

        Returns:
            Duration in milliseconds
        """
        if name not in self._timers:
            return 0

        duration_ms = int((time.time() - self._timers[name]) * 1000)

        # Map timer name to metrics field
        field_name = f"{name}_duration_ms"
        if hasattr(self.metrics, field_name):
            setattr(self.metrics, field_name, duration_ms)

        del self._timers[name]
        return duration_ms

    def record_tokens(self, input_tokens: int, output_tokens: int) -> None:
        """
        Record token usage.

        Args:
            input_tokens: Number of input tokens
            output_tokens: Number of output tokens
        """
        self.metrics.tokens_input += input_tokens
        self.metrics.tokens_output += output_tokens

    def record_tool_call(self, duration_ms: int) -> None:
        """
        Record a tool call.

        Args:
            duration_ms: Call duration in milliseconds
        """
        self.metrics.tool_calls += 1
        self.metrics.tool_latency_ms += duration_ms

    def record_skill_call(self, duration_ms: int) -> None:
        """
        Record a skill call.

        Args:
            duration_ms: Call duration in milliseconds
        """
        self.metrics.skill_calls += 1

    def record_llm_call(self, latency_ms: int) -> None:
        """
        Record an LLM call.

        Args:
            latency_ms: Call latency in milliseconds
        """
        self.metrics.llm_latency_ms += latency_ms

    def record_error(self) -> None:
        """Record an error occurrence."""
        self.metrics.errors += 1

    def record_iteration(self) -> None:
        """Record a loop iteration."""
        self.metrics.iterations += 1

    def set_model(self, model: str) -> None:
        """
        Set the model used.

        Args:
            model: Model name
        """
        self.metrics.model = model

    def finalize(self) -> ExecutionMetrics:
        """
        Finalize and return the metrics.

        Returns:
            Final ExecutionMetrics
        """
        self.metrics.total_duration_ms = int((time.time() - self._start_time) * 1000)
        return self.metrics

    def get_metrics(self) -> ExecutionMetrics:
        """
        Get current metrics snapshot.

        Returns:
            Current ExecutionMetrics
        """
        return self.metrics

    def to_dict(self) -> dict[str, Any]:
        """
        Convert metrics to dictionary.

        Returns:
            Dictionary representation
        """
        metrics = self.finalize()
        return {
            "session_id": metrics.session_id,
            "agent_id": metrics.agent_id,
            "total_duration_ms": metrics.total_duration_ms,
            "plan_duration_ms": metrics.plan_duration_ms,
            "act_duration_ms": metrics.act_duration_ms,
            "llm_latency_ms": metrics.llm_latency_ms,
            "tool_latency_ms": metrics.tool_latency_ms,
            "tokens_input": metrics.tokens_input,
            "tokens_output": metrics.tokens_output,
            "iterations": metrics.iterations,
            "tool_calls": metrics.tool_calls,
            "skill_calls": metrics.skill_calls,
            "errors": metrics.errors,
            "model": metrics.model,
        }

    async def flush(self, db_path: str | None = None) -> None:
        """
        Flush metrics to local SQLite (~/.semibot/semibot.db).

        Args:
            db_path: Optional override for the SQLite database path
        """
        metrics = self.finalize()

        resolved_path = Path(db_path).expanduser() if db_path else Path("~/.semibot/semibot.db").expanduser()
        resolved_path.parent.mkdir(parents=True, exist_ok=True)

        try:
            conn = sqlite3.connect(resolved_path, timeout=30)
            try:
                conn.execute("PRAGMA journal_mode=WAL")
                conn.execute("PRAGMA busy_timeout = 30000")
                conn.execute(
                    """
                    CREATE TABLE IF NOT EXISTS execution_logs (
                        id TEXT PRIMARY KEY,
                        agent_id TEXT,
                        session_id TEXT,
                        state TEXT,
                        duration_ms INTEGER,
                        tokens_input INTEGER DEFAULT 0,
                        tokens_output INTEGER DEFAULT 0,
                        tool_calls INTEGER DEFAULT 0,
                        errors INTEGER DEFAULT 0,
                        model TEXT,
                        created_at TEXT NOT NULL
                    )
                    """,
                )
                conn.execute(
                    """
                    INSERT INTO execution_logs
                    (id, agent_id, session_id, state, duration_ms, tokens_input,
                     tokens_output, tool_calls, errors, model, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
                    """,
                    (
                        str(uuid4()),
                        metrics.agent_id,
                        metrics.session_id,
                        "completed",
                        metrics.total_duration_ms,
                        metrics.tokens_input,
                        metrics.tokens_output,
                        metrics.tool_calls,
                        metrics.errors,
                        metrics.model,
                    ),
                )
                conn.commit()
            finally:
                conn.close()
        except Exception as e:
            logger.warning("failed_to_write_metrics_to_sqlite", error=str(e))
