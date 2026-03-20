from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal


@dataclass(frozen=True)
class HealthProbe:
    kind: Literal["port", "http"]
    target: str
    timeout_seconds: float = 10.0


@dataclass(frozen=True)
class ServiceDefinition:
    service_id: str
    name: str
    command: list[str]
    cwd: Path
    logfile: Path
    error_logfile: Path
    pidfile: Path
    manager: Literal["pm2", "direct", "supervisor"] = "supervisor"
    entrypoint_kind: Literal["launcher", "direct"] = "direct"
    env: dict[str, str] = field(default_factory=dict)
    ports: list[int] = field(default_factory=list)
    probes: list[HealthProbe] = field(default_factory=list)


@dataclass(frozen=True)
class ServiceStatus:
    service_id: str
    state: Literal["running", "stopped", "degraded"]
    pid: int | None = None
    message: str | None = None
