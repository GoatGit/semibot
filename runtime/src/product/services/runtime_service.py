from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any

from src.product.config import ProductConfigLoader
from src.product.health import probe_http_with_retry, probe_port_with_retry
from src.product.installer import InstallLayout
from src.product.services.manager import ServiceManager
from src.product.services.model import HealthProbe, ServiceDefinition
from src.product.services.supervisor import LocalSupervisor


@dataclass(frozen=True)
class RuntimeServiceOptions:
    name: str = "semibot-runtime"
    host: str | None = None
    port: int | None = None
    db_path: str | None = None
    rules_path: str | None = None
    heartbeat_interval: float | None = None
    cron_jobs_json: str | None = None


class LocalRuntimeServiceManager(ServiceManager):
    """Built-in local supervisor wrapper for the runtime daemon."""

    def __init__(self, options: RuntimeServiceOptions) -> None:
        self.source_root = Path(__file__).resolve().parents[4]
        config_loader = ProductConfigLoader()
        self.config_loader = config_loader
        resolved = config_loader.load(
            {
                "runtime_host": options.host,
                "runtime_port": options.port,
                "runtime_db_path": options.db_path,
                "runtime_rules_path": options.rules_path,
                "runtime_heartbeat_interval": options.heartbeat_interval,
                "runtime_cron_jobs_json": options.cron_jobs_json,
            }
        )
        self.options = RuntimeServiceOptions(
            name=options.name,
            host=resolved.runtime.host,
            port=resolved.runtime.port,
            db_path=resolved.runtime.db_path,
            rules_path=resolved.runtime.rules_path,
            heartbeat_interval=options.heartbeat_interval,
            cron_jobs_json=options.cron_jobs_json,
        )
        self.product_config = resolved
        layout = InstallLayout.discover(config_loader.paths.home)
        self.project_root = layout.installed_workspace_root() or self.source_root
        self.supervisor = LocalSupervisor()

    def status_payload(self, definition: ServiceDefinition | None = None) -> dict[str, Any]:
        definition = definition or self._definition()
        status = self.supervisor.status(definition)
        health = self._health_payload()
        running = status.get("status") == "running"
        state = "running" if running and health["status"] == "ok" else ("degraded" if running else "stopped")
        payload = {
            "ok": True,
            "manager": "supervisor",
            "name": self.options.name,
            "host": self.options.host,
            "port": self.options.port,
            "status": state,
            "pid": status.get("pid"),
            "paths": {
                "home": str(self.config_loader.paths.home),
                "logs_dir": str(self.config_loader.paths.logs_dir),
                "run_dir": str(self.config_loader.paths.run_dir),
                "log_file": str(definition.logfile),
                "error_log_file": str(definition.error_logfile),
                "source_root": str(self.source_root),
                "execution_root": str(self.project_root),
            },
            "health": health if running else {"status": "fail", "checks": []},
            "feature_flags": self.product_config.feature_flags,
            "definition": {
                "service_id": definition.service_id,
                "name": definition.name,
                "manager": definition.manager,
                "entrypoint_kind": definition.entrypoint_kind,
                "cwd": str(definition.cwd),
                "command": definition.command,
                "logfile": str(definition.logfile),
                "error_logfile": str(definition.error_logfile),
                "pidfile": str(definition.pidfile),
            },
        }
        snapshot_path = self.config_loader.write_state_snapshot(action="serve-status", payload=payload)
        payload["snapshot_file"] = str(snapshot_path) if snapshot_path else None
        return payload

    def status(self, definition: ServiceDefinition | None = None) -> dict[str, Any]:
        return self.status_payload(definition)

    def start(self, definition: ServiceDefinition | None = None) -> dict[str, Any]:
        self._validate_cron_jobs()
        definition = definition or self._definition()
        try:
            detail = self.supervisor.start(definition)
        except RuntimeError as exc:
            diagnostics = {
                "service": definition.service_id,
                "name": definition.name,
                "log_file": str(definition.logfile),
                "error_log_file": str(definition.error_logfile),
                "stderr_tail": self.supervisor.tail(definition.error_logfile, 20),
                "stdout_tail": self.supervisor.tail(definition.logfile, 10),
            }
            raise RuntimeError(f"runtime start failed:\n{exc}\n--- diagnostics ---\n{diagnostics}") from exc
        payload = self.status_payload(definition)
        return {"ok": True, "action": "start", **detail, **payload}

    def stop(self, definition: ServiceDefinition | None = None) -> dict[str, Any]:
        definition = definition or self._definition()
        detail = self.supervisor.stop(definition)
        return {"ok": True, "action": "stop", **detail, **self.status_payload(definition)}

    def restart(self) -> dict[str, Any]:
        definition = self._definition()
        try:
            detail = self.supervisor.restart(definition)
        except RuntimeError as exc:
            diagnostics = {
                "service": definition.service_id,
                "name": definition.name,
                "log_file": str(definition.logfile),
                "error_log_file": str(definition.error_logfile),
                "stderr_tail": self.supervisor.tail(definition.error_logfile, 20),
                "stdout_tail": self.supervisor.tail(definition.logfile, 10),
            }
            raise RuntimeError(f"runtime restart failed:\n{exc}\n--- diagnostics ---\n{diagnostics}") from exc
        return {"ok": True, "action": "restart", "steps": detail, **self.status_payload(definition)}

    def _definition(self) -> ServiceDefinition:
        return ServiceDefinition(
            service_id="runtime",
            name=self.options.name,
            command=self._start_command(),
            cwd=self.project_root / "runtime",
            logfile=self.config_loader.paths.logs_dir / f"{self.options.name}.out.log",
            error_logfile=self.config_loader.paths.logs_dir / f"{self.options.name}.err.log",
            pidfile=self.config_loader.paths.run_dir / f"{self.options.name}.pid",
            manager="supervisor",
            entrypoint_kind="launcher",
            env=self._runtime_env(),
            ports=[self.options.port],
            probes=[
                HealthProbe(kind="port", target=f"{self.options.host}:{self.options.port}", timeout_seconds=2.0),
                HealthProbe(kind="http", target=f"http://{self.options.host}:{self.options.port}/health", timeout_seconds=3.0),
            ],
        )

    def _validate_cron_jobs(self) -> None:
        raw = self.options.cron_jobs_json
        if not raw:
            return
        try:
            parsed = __import__("json").loads(raw)
        except Exception as exc:
            raise RuntimeError(f"invalid --cron-jobs-json: {exc}") from exc
        if not isinstance(parsed, list):
            raise RuntimeError("invalid --cron-jobs-json, expected JSON array")

    def _start_command(self) -> list[str]:
        return ["bash", str(self.project_root / "runtime" / "scripts" / "launch_runtime.sh")]

    def _runtime_env(self) -> dict[str, str]:
        env = {
            "HOST": self.options.host,
            "RUNTIME_PORT": str(self.options.port),
            "RUNTIME_DB_PATH": self.options.db_path,
            "RUNTIME_RULES_PATH": self.options.rules_path,
            "SEMIBOT_SQLITE_DEFAULT": "1" if self.product_config.feature_flags.get("sqlite_default", True) else "0",
            "SEMIBOT_POSTGRES_ENABLED": "1" if self.product_config.feature_flags.get("postgres_enabled", False) else "0",
            "SEMIBOT_REDIS_ENABLED": "1" if self.product_config.feature_flags.get("redis_enabled", False) else "0",
            "SEMIBOT_DOCKER_SANDBOX_ENABLED": "1" if self.product_config.feature_flags.get("docker_sandbox_enabled", False) else "0",
        }
        if self.options.heartbeat_interval is not None:
            env["RUNTIME_HEARTBEAT_INTERVAL"] = str(self.options.heartbeat_interval)
        if self.options.cron_jobs_json:
            env["RUNTIME_CRON_JOBS_JSON"] = self.options.cron_jobs_json
        return env

    def _health_payload(self) -> dict[str, Any]:
        checks = [
            probe_port_with_retry(self.options.host, self.options.port, attempts=3, interval_seconds=0.4),
            probe_http_with_retry(
                f"http://{self.options.host}:{self.options.port}/health",
                attempts=3,
                interval_seconds=0.4,
            ),
        ]
        status = "ok"
        if any(item.status == "fail" for item in checks):
            status = "fail"
        elif any(item.status == "warn" for item in checks):
            status = "warn"
        return {
            "status": status,
            "checks": [
                {"name": item.name, "status": item.status, "message": item.message, "details": item.details}
                for item in checks
            ],
        }
