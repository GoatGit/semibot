"""Health report primitives for install-mode diagnostics."""

from .checks import (
    HealthCheckResult,
    HealthReport,
    probe_http,
    probe_http_with_retry,
    probe_port,
    probe_port_with_retry,
)

__all__ = [
    "HealthCheckResult",
    "HealthReport",
    "probe_http",
    "probe_http_with_retry",
    "probe_port",
    "probe_port_with_retry",
]
