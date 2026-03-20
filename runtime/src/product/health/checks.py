from __future__ import annotations

from dataclasses import dataclass, field, replace
import socket
import time
from typing import Any, Literal
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


HealthStatus = Literal["ok", "warn", "fail"]


@dataclass(frozen=True)
class HealthCheckResult:
    name: str
    status: HealthStatus
    message: str
    details: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class HealthReport:
    checks: list[HealthCheckResult]

    @property
    def ok(self) -> bool:
        return all(item.status != "fail" for item in self.checks)


def probe_port(host: str, port: int, *, timeout_seconds: float = 2.0) -> HealthCheckResult:
    try:
        with socket.create_connection((host, port), timeout=timeout_seconds):
            return HealthCheckResult(
                name=f"tcp://{host}:{port}",
                status="ok",
                message="port reachable",
                details={"host": host, "port": port, "timeout_seconds": timeout_seconds},
            )
    except OSError as exc:
        return HealthCheckResult(
            name=f"tcp://{host}:{port}",
            status="fail",
            message="port unreachable",
            details={"host": host, "port": port, "timeout_seconds": timeout_seconds, "error": str(exc)},
        )


def probe_http(url: str, *, timeout_seconds: float = 3.0) -> HealthCheckResult:
    request = Request(url, headers={"User-Agent": "semibot-product-healthcheck/1"})
    try:
        with urlopen(request, timeout=timeout_seconds) as response:
            status_code = getattr(response, "status", None) or response.getcode()
            status: HealthStatus = "ok" if 200 <= int(status_code) < 500 else "fail"
            return HealthCheckResult(
                name=url,
                status=status,
                message=f"http {status_code}",
                details={"url": url, "status_code": int(status_code), "timeout_seconds": timeout_seconds},
            )
    except HTTPError as exc:
        status: HealthStatus = "warn" if 400 <= exc.code < 500 else "fail"
        return HealthCheckResult(
            name=url,
            status=status,
            message=f"http {exc.code}",
            details={"url": url, "status_code": exc.code, "timeout_seconds": timeout_seconds},
        )
    except URLError as exc:
        return HealthCheckResult(
            name=url,
            status="fail",
            message="request failed",
            details={"url": url, "timeout_seconds": timeout_seconds, "error": str(exc.reason)},
        )


def probe_port_with_retry(
    host: str,
    port: int,
    *,
    timeout_seconds: float = 2.0,
    attempts: int = 3,
    interval_seconds: float = 0.5,
) -> HealthCheckResult:
    last = probe_port(host, port, timeout_seconds=timeout_seconds)
    if attempts > 1:
        last = replace(last, details={**last.details, "attempt": 1})
    for attempt in range(2, max(1, attempts) + 1):
        if last.status == "ok":
            return last
        time.sleep(max(0.0, interval_seconds))
        last = probe_port(host, port, timeout_seconds=timeout_seconds)
        last = replace(last, details={**last.details, "attempt": attempt})
    return last


def probe_http_with_retry(
    url: str,
    *,
    timeout_seconds: float = 3.0,
    attempts: int = 3,
    interval_seconds: float = 0.5,
) -> HealthCheckResult:
    last = probe_http(url, timeout_seconds=timeout_seconds)
    if attempts > 1:
        last = replace(last, details={**last.details, "attempt": 1})
    for attempt in range(2, max(1, attempts) + 1):
        if last.status == "ok":
            return last
        time.sleep(max(0.0, interval_seconds))
        last = probe_http(url, timeout_seconds=timeout_seconds)
        last = replace(last, details={**last.details, "attempt": attempt})
    return last
