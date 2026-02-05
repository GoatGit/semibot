"""Logging utilities for the runtime."""

import logging
import sys
from typing import Any

import structlog


def setup_logging(
    level: str = "INFO",
    json_format: bool = False,
) -> None:
    """
    Setup structured logging for the runtime.

    Args:
        level: Log level (DEBUG, INFO, WARNING, ERROR)
        json_format: Whether to output JSON format logs
    """
    # Configure standard library logging
    logging.basicConfig(
        format="%(message)s",
        stream=sys.stdout,
        level=getattr(logging, level.upper()),
    )

    # Configure structlog
    processors = [
        structlog.contextvars.merge_contextvars,
        structlog.processors.add_log_level,
        structlog.processors.TimeStamper(fmt="iso"),
        structlog.processors.StackInfoRenderer(),
    ]

    if json_format:
        processors.append(structlog.processors.JSONRenderer())
    else:
        processors.append(structlog.dev.ConsoleRenderer())

    structlog.configure(
        processors=processors,
        wrapper_class=structlog.make_filtering_bound_logger(
            getattr(logging, level.upper())
        ),
        context_class=dict,
        logger_factory=structlog.PrintLoggerFactory(),
        cache_logger_on_first_use=True,
    )


def get_logger(name: str, **initial_values: Any) -> structlog.BoundLogger:
    """
    Get a configured logger instance.

    Args:
        name: Logger name (usually module name)
        **initial_values: Initial context values

    Returns:
        Configured structlog BoundLogger
    """
    logger = structlog.get_logger(name)
    if initial_values:
        logger = logger.bind(**initial_values)
    return logger


class ExecutionLogger:
    """
    Specialized logger for agent execution.

    Provides structured logging for:
    - State transitions
    - Tool calls
    - LLM interactions
    - Errors
    """

    def __init__(self, session_id: str, agent_id: str):
        """
        Initialize the execution logger.

        Args:
            session_id: Session identifier
            agent_id: Agent identifier
        """
        self.logger = get_logger(
            "execution",
            session_id=session_id,
            agent_id=agent_id,
        )

    def log_state_transition(
        self,
        from_state: str,
        to_state: str,
        reason: str = "",
    ) -> None:
        """Log a state transition."""
        self.logger.info(
            "state_transition",
            from_state=from_state,
            to_state=to_state,
            reason=reason,
        )

    def log_tool_call(
        self,
        tool_name: str,
        params: dict[str, Any],
        result: Any,
        duration_ms: int,
        success: bool = True,
    ) -> None:
        """Log a tool call."""
        log_method = self.logger.info if success else self.logger.warning
        log_method(
            "tool_call",
            tool_name=tool_name,
            params=params,
            result_preview=str(result)[:200] if result else None,
            duration_ms=duration_ms,
            success=success,
        )

    def log_llm_call(
        self,
        model: str,
        tokens_in: int,
        tokens_out: int,
        latency_ms: int,
    ) -> None:
        """Log an LLM call."""
        self.logger.info(
            "llm_call",
            model=model,
            tokens_input=tokens_in,
            tokens_output=tokens_out,
            latency_ms=latency_ms,
        )

    def log_error(
        self,
        error_code: str,
        message: str,
        details: dict[str, Any] | None = None,
    ) -> None:
        """Log an error."""
        self.logger.error(
            "execution_error",
            error_code=error_code,
            message=message,
            details=details or {},
        )

    def log_plan_generated(
        self,
        goal: str,
        step_count: int,
    ) -> None:
        """Log plan generation."""
        self.logger.info(
            "plan_generated",
            goal=goal,
            step_count=step_count,
        )

    def log_completion(
        self,
        total_duration_ms: int,
        iterations: int,
        success: bool = True,
    ) -> None:
        """Log execution completion."""
        log_method = self.logger.info if success else self.logger.warning
        log_method(
            "execution_complete",
            total_duration_ms=total_duration_ms,
            iterations=iterations,
            success=success,
        )
