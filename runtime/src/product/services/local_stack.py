from __future__ import annotations

import hashlib
import os
import signal
import shutil
import subprocess
import sys
import time
import webbrowser
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from src.llm.provider_factory import infer_provider_base_from_model
from src.product.config import ProductConfigLoader
from src.product.health import probe_http_with_retry, probe_port_with_retry
from src.product.installer import InstallLayout
from src.product.services.model import HealthProbe, ServiceDefinition
from src.product.services.supervisor import LocalSupervisor
from src.product.versioning import resolve_update_payload


@dataclass(frozen=True)
class StackOptions:
    name_prefix: str | None = None
    runtime_name: str | None = None
    runtime_host: str | None = None
    runtime_port: int | None = None
    api_port: int | None = None
    web_port: int | None = None
    runtime_db_path: str | None = None
    runtime_rules_path: str | None = None
    runtime_heartbeat_interval: float | None = None
    runtime_cron_jobs_json: str | None = None
    with_runtime: bool = True
    wait_for_health: bool = True
    health_timeout_seconds: float = 30.0


class LocalProductStack:
    """Product-layer stack manager backed by the built-in local supervisor."""

    def __init__(self, options: StackOptions) -> None:
        self.source_root = Path(__file__).resolve().parents[4]
        config_loader = ProductConfigLoader()
        self.config_loader = config_loader
        resolved = config_loader.load(
            {
                "runtime_host": options.runtime_host,
                "runtime_port": options.runtime_port,
                "api_port": options.api_port,
                "web_port": options.web_port,
                "runtime_db_path": options.runtime_db_path,
                "runtime_rules_path": options.runtime_rules_path,
                "runtime_heartbeat_interval": options.runtime_heartbeat_interval,
                "runtime_cron_jobs_json": options.runtime_cron_jobs_json,
            }
        )
        self.options = StackOptions(
            name_prefix=options.name_prefix,
            runtime_name=options.runtime_name,
            runtime_host=resolved.runtime.host,
            runtime_port=resolved.runtime.port,
            api_port=resolved.ports.api,
            web_port=resolved.ports.web,
            runtime_db_path=resolved.runtime.db_path,
            runtime_rules_path=resolved.runtime.rules_path,
            runtime_heartbeat_interval=options.runtime_heartbeat_interval,
            runtime_cron_jobs_json=options.runtime_cron_jobs_json,
            with_runtime=options.with_runtime,
            wait_for_health=options.wait_for_health,
            health_timeout_seconds=options.health_timeout_seconds,
        )
        self.install_layout = InstallLayout.discover(config_loader.paths.home)
        self.project_root = self._resolve_execution_root()
        self.logs_dir = config_loader.paths.logs_dir
        self.run_dir = config_loader.paths.run_dir
        self.product_config = resolved
        self.name_prefix = self._resolve_ui_name_prefix(self.options.name_prefix)
        self.runtime_name = (self.options.runtime_name or "").strip() or "semibot-runtime"
        self.supervisor = LocalSupervisor()

    @property
    def ui_url(self) -> str:
        return f"http://127.0.0.1:{self.options.web_port}"

    def status_payload(self) -> dict[str, Any]:
        definitions = self.service_definitions()
        services: list[dict[str, Any]] = []
        for service_name in self._service_order():
            definition = definitions[service_name]
            services.append(self._service_summary(definition))

        overall = "running"
        if any(item.get("status") == "stopped" for item in services):
            overall = "degraded" if any(item.get("status") == "running" for item in services) else "stopped"
        elif any((item.get("health") or {}).get("status") == "fail" for item in services):
            overall = "degraded"

        current_version = str(self.install_layout.active_release_version() or "").strip() or None
        updates = resolve_update_payload(
            manifest_url=self.product_config.updates.manifest_url,
            current_version=current_version,
        )

        payload = {
            "ok": True,
            "project_root": str(self.project_root),
            "pnpm_available": self._pnpm_available(),
            "manager": "supervisor",
            "name_prefix": self.name_prefix,
            "launch_mode": self._launch_mode(),
            "paths": {
                "home": str(self.config_loader.paths.home),
                "config_dir": str(self.config_loader.paths.config_dir),
                "logs_dir": str(self.config_loader.paths.logs_dir),
                "run_dir": str(self.config_loader.paths.run_dir),
                "releases_dir": str(self.config_loader.paths.releases_dir),
            },
            "feature_flags": self.product_config.feature_flags,
            "release": self.install_layout.release_payload(),
            "updates": updates,
            "source_root": str(self.source_root),
            "execution_root": str(self.project_root),
            "service_definitions": {key: self._serialize_definition(value) for key, value in definitions.items()},
            "services": services,
            "status": overall,
            "ui_url": self.ui_url,
        }
        snapshot_path = self.config_loader.write_state_snapshot(action="status", payload=payload)
        payload["snapshot_file"] = str(snapshot_path) if snapshot_path else None
        return payload

    def start(self) -> dict[str, Any]:
        self._ensure_workspace_packages()
        definitions = self.service_definitions()
        stale_steps = self._stop_stale_services(definitions)
        steps: list[dict[str, Any]] = []
        started: list[str] = []

        try:
            for service_name in self._service_order():
                definition = definitions[service_name]
                detail = self.supervisor.start(
                    definition,
                    replace_existing=self._should_replace_existing_service(definition),
                )
                steps.append(
                    {
                        "step": "start",
                        "service": service_name,
                        "name": definition.name,
                        **detail,
                    }
                )
                if not detail.get("already_running"):
                    started.append(service_name)
        except RuntimeError as exc:
            rollback_steps: list[dict[str, Any]] = []
            rollback_errors: list[dict[str, Any]] = []
            for rollback_service in reversed(started):
                rollback_definition = definitions[rollback_service]
                try:
                    rollback_detail = self.supervisor.stop(rollback_definition)
                    rollback_steps.append(
                        {
                            "step": "rollback-stop",
                            "service": rollback_service,
                            "name": rollback_definition.name,
                            **rollback_detail,
                        }
                    )
                except Exception as rollback_exc:
                    rollback_errors.append(
                        {
                            "step": "rollback-stop",
                            "service": rollback_service,
                            "name": rollback_definition.name,
                            "error": str(rollback_exc),
                        }
                    )
            status_payload = self.status_payload()
            raise RuntimeError(
                self._format_start_failure(
                    exc,
                    steps=steps,
                    rollback_steps=rollback_steps,
                    services=status_payload["services"],
                    rollback_errors=rollback_errors,
                )
            ) from exc

        wait = self._wait_for_stack_health() if self.options.wait_for_health else {
            "attempted": False,
            "ready": False,
            "timeout_seconds": self.options.health_timeout_seconds,
            "services": [],
        }
        status_payload = self.status_payload()
        if self.options.wait_for_health and not wait.get("ready"):
            diagnostics = self._collect_failure_diagnostics(status_payload["services"])
            raise RuntimeError(self._format_wait_failure(wait=wait, services=status_payload["services"], diagnostics=diagnostics))
        payload = {
            "ok": True,
            "action": "start",
            "project_root": str(self.project_root),
            "runtime": {"enabled": self.options.with_runtime, "name": self.runtime_name, "manager": "supervisor"},
            "steps": stale_steps + steps,
            "services": status_payload["services"],
            "ui_url": self.ui_url,
            "wait": wait,
        }
        snapshot_path = self.config_loader.write_state_snapshot(action="up", payload=payload)
        payload["snapshot_file"] = str(snapshot_path) if snapshot_path else None
        return payload

    def stop(self) -> dict[str, Any]:
        definitions = self.service_definitions()
        steps: list[dict[str, Any]] = []
        steps.extend(self._stop_stale_services(definitions))
        for service_name in reversed(self._service_order()):
            definition = definitions[service_name]
            detail = self.supervisor.stop(definition)
            steps.append({"step": "stop", "service": service_name, "name": definition.name, **detail})
        payload = {
            "ok": True,
            "action": "stop",
            "project_root": str(self.project_root),
            "steps": steps,
            "services": self.status_payload()["services"],
            "ui_url": self.ui_url,
        }
        snapshot_path = self.config_loader.write_state_snapshot(action="down", payload=payload)
        payload["snapshot_file"] = str(snapshot_path) if snapshot_path else None
        return payload

    def open_ui(self, *, should_open: bool = True) -> dict[str, Any]:
        start_payload = self.start()
        browser = self._open_url_in_browser(self.ui_url) if should_open else {
            "attempted": False,
            "opened": False,
            "url": self.ui_url,
        }
        payload = {
            "ok": True,
            "action": "open",
            "url": self.ui_url,
            "browser": browser,
            "services": start_payload["services"],
            "wait": start_payload.get("wait"),
        }
        snapshot_path = self.config_loader.write_state_snapshot(action="ui", payload=payload)
        payload["snapshot_file"] = str(snapshot_path) if snapshot_path else None
        return payload

    def restart(self) -> dict[str, Any]:
        stop_payload = self.stop()
        start_payload = self.start()
        payload = {
            "ok": True,
            "action": "restart",
            "project_root": str(self.project_root),
            "steps": (stop_payload.get("steps") or []) + (start_payload.get("steps") or []),
            "services": start_payload["services"],
            "ui_url": self.ui_url,
            "wait": start_payload.get("wait"),
        }
        snapshot_path = self.config_loader.write_state_snapshot(action="restart", payload=payload)
        payload["snapshot_file"] = str(snapshot_path) if snapshot_path else None
        return payload

    def logs_payload(self, service: str | None = None, *, lines: int = 100) -> dict[str, Any]:
        requested = (service or "all").strip().lower()
        services = self.status_payload()["services"]
        if requested != "all":
            services = [item for item in services if item.get("service") == requested]
            if not services:
                raise RuntimeError(f"unknown service: {service}")
        entries = []
        for item in services:
            out_log = Path(str(item.get("log_file") or ""))
            error_log = Path(str(item.get("error_log_file") or ""))
            entries.append(
                {
                    "service": item.get("service"),
                    "name": item.get("name"),
                    "log_file": str(out_log) if out_log else None,
                    "error_log_file": str(error_log) if error_log else None,
                    "tail": {
                        "stdout": self._tail_file(out_log, lines) if out_log else [],
                        "stderr": self._tail_file(error_log, lines) if error_log else [],
                    },
                }
            )
        payload = {"ok": True, "service": requested, "lines": lines, "entries": entries}
        snapshot_path = self.config_loader.write_state_snapshot(action="logs", payload=payload)
        payload["snapshot_file"] = str(snapshot_path) if snapshot_path else None
        return payload

    def service_definitions(self) -> dict[str, ServiceDefinition]:
        definitions: dict[str, ServiceDefinition] = {}
        if self.options.with_runtime:
            definitions["runtime"] = ServiceDefinition(
                service_id="runtime",
                name=self.runtime_name,
                command=self._runtime_command(),
                cwd=self.project_root / "runtime",
                logfile=self.logs_dir / f"{self.runtime_name}.out.log",
                error_logfile=self.logs_dir / f"{self.runtime_name}.err.log",
                pidfile=self.run_dir / f"{self.runtime_name}.pid",
                manager="supervisor",
                entrypoint_kind="launcher",
                env=self._runtime_env(),
                ports=[self.options.runtime_port],
                probes=[
                    HealthProbe(kind="port", target=f"127.0.0.1:{self.options.runtime_port}", timeout_seconds=2.0),
                    HealthProbe(kind="http", target=f"http://127.0.0.1:{self.options.runtime_port}/health", timeout_seconds=3.0),
                ],
            )
        for service_name, process_name in self._ui_process_names().items():
            port = self.options.api_port if service_name == "api" else self.options.web_port
            definitions[service_name] = ServiceDefinition(
                service_id=service_name,
                name=process_name,
                command=self._ui_command(service=service_name),
                cwd=self.project_root,
                logfile=self.logs_dir / f"{process_name}.out.log",
                error_logfile=self.logs_dir / f"{process_name}.err.log",
                pidfile=self.run_dir / f"{process_name}.pid",
                manager="supervisor",
                entrypoint_kind="launcher",
                env=self._ui_env(service=service_name),
                ports=[port],
                probes=[
                    HealthProbe(kind="port", target=f"127.0.0.1:{port}", timeout_seconds=2.0),
                    HealthProbe(kind="http", target=f"http://127.0.0.1:{port}/", timeout_seconds=3.0),
                ],
            )
        return definitions

    def _service_order(self) -> list[str]:
        order: list[str] = []
        if self.options.with_runtime:
            order.append("runtime")
        order.extend(["api", "web"])
        return order

    def _pnpm_available(self) -> bool:
        return shutil.which("pnpm") is not None

    def _ensure_workspace_packages(self) -> None:
        missing = [
            str(path)
            for path in [
                self.project_root / "apps" / "api" / "package.json",
                self.project_root / "apps" / "web" / "package.json",
            ]
            if not path.exists()
        ]
        if missing:
            raise RuntimeError("required UI/API workspace packages not found")

    def _ui_process_names(self) -> dict[str, str]:
        return {"api": f"{self.name_prefix}-api", "web": f"{self.name_prefix}-web"}

    def _resolve_ui_name_prefix(self, raw_value: str | None) -> str:
        value = (raw_value or "").strip()
        if value:
            return value
        stable_root = str(self.config_loader.paths.home.resolve()).encode("utf-8")
        normalized = stable_root
        suffix = hashlib.sha1(normalized).hexdigest()[:8]
        return f"semibot-ui-{suffix}"

    def _stop_stale_services(self, definitions: dict[str, ServiceDefinition]) -> list[dict[str, Any]]:
        stale_steps: list[dict[str, Any]] = []
        stale_steps.extend(self._stop_stale_ui_pidfiles(definitions))
        stale_steps.extend(self._stop_stale_port_owners(definitions))
        return stale_steps

    def _stop_stale_ui_pidfiles(self, definitions: dict[str, ServiceDefinition]) -> list[dict[str, Any]]:
        current_names = {definition.name for definition in definitions.values()}
        stale_steps: list[dict[str, Any]] = []
        for pidfile in sorted(self.run_dir.glob("semibot-ui-*.pid")):
            service_name = pidfile.name[: -len(".pid")]
            if service_name in current_names:
                continue
            if not (service_name.endswith("-api") or service_name.endswith("-web")):
                continue
            logfile = self.logs_dir / f"{service_name}.out.log"
            error_logfile = self.logs_dir / f"{service_name}.err.log"
            definition = ServiceDefinition(
                service_id="legacy-ui",
                name=service_name,
                command=[],
                cwd=self.project_root,
                logfile=logfile,
                error_logfile=error_logfile,
                pidfile=pidfile,
                manager="supervisor",
                entrypoint_kind="launcher",
                env={},
                ports=[],
                probes=[],
            )
            detail = self.supervisor.stop(definition)
            stale_steps.append(
                {
                    "step": "stop-stale-ui",
                    "service": "legacy-ui",
                    "name": service_name,
                    **detail,
                }
            )
        return stale_steps

    def _stop_stale_port_owners(self, definitions: dict[str, ServiceDefinition]) -> list[dict[str, Any]]:
        protected_pids = {
            status.get("pid")
            for definition in definitions.values()
            for status in [self.supervisor.status(definition)]
            if status.get("status") == "running" and status.get("pid")
        }
        stale_steps: list[dict[str, Any]] = []
        for definition in definitions.values():
            for port in definition.ports:
                pid = self._listening_pid_for_port(port)
                if pid is None or pid in protected_pids:
                    continue
                command = self._read_process_command(pid)
                if not self._is_semibot_managed_command(command):
                    continue
                stopped = self._terminate_pid(pid)
                stale_steps.append(
                    {
                        "step": "stop-stale-port-owner",
                        "service": definition.service_id,
                        "name": definition.name,
                        "port": port,
                        "pid": pid,
                        "stopped": stopped,
                        "command": command,
                    }
                )
        return stale_steps

    def _listening_pid_for_port(self, port: int) -> int | None:
        try:
            result = subprocess.run(
                ["lsof", "-tiTCP:%s" % port, "-sTCP:LISTEN"],
                capture_output=True,
                text=True,
                check=False,
            )
        except Exception:
            return None
        if result.returncode not in (0, 1):
            return None
        for line in result.stdout.splitlines():
            raw = line.strip()
            if not raw:
                continue
            try:
                return int(raw)
            except ValueError:
                continue
        return None

    def _read_process_command(self, pid: int) -> str:
        try:
            result = subprocess.run(
                ["ps", "-o", "command=", "-p", str(pid)],
                capture_output=True,
                text=True,
                check=False,
            )
        except Exception:
            return ""
        if result.returncode != 0:
            return ""
        return result.stdout.strip()

    def _is_semibot_managed_command(self, command: str) -> bool:
        normalized = str(command or "").strip().lower()
        if not normalized:
            return False
        return any(
            marker in normalized
            for marker in (
                "semibot",
                "launch_runtime.sh",
                "launch_api.sh",
                "launch_web.sh",
                "next-server",
                "next/dist/bin/next",
                "src/index.ts",
                "dist/index.js",
                "main.py serve-daemon",
            )
        )

    def _terminate_pid(self, pid: int, timeout_seconds: float = 8.0) -> bool:
        try:
            os.killpg(pid, signal.SIGTERM)
        except Exception:
            try:
                os.kill(pid, signal.SIGTERM)
            except ProcessLookupError:
                return True
            except Exception:
                return False
        deadline = time.monotonic() + max(1.0, timeout_seconds)
        while time.monotonic() < deadline:
            if not self.supervisor._is_running(pid):
                return True
            time.sleep(0.2)
        try:
            os.killpg(pid, signal.SIGKILL)
        except Exception:
            try:
                os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                return True
            except Exception:
                return False
        time.sleep(0.2)
        return not self.supervisor._is_running(pid)

    def _service_summary(self, definition: ServiceDefinition) -> dict[str, Any]:
        supervisor_status = self.supervisor.status(definition)
        health_checks = self._health_checks_for(definition)
        health_status = "ok"
        if any(item.status == "fail" for item in health_checks):
            health_status = "fail"
        elif any(item.status == "warn" for item in health_checks):
            health_status = "warn"
        running = supervisor_status.get("status") == "running"
        return {
            "name": definition.name,
            "status": "running" if running else "stopped",
            "pid": supervisor_status.get("pid"),
            "health": {
                "status": health_status if running else "fail",
                "checks": [
                    {
                        "name": item.name,
                        "status": item.status,
                        "message": item.message,
                        "details": item.details,
                    }
                    for item in health_checks
                ] if running else [],
            },
            "log_file": str(definition.logfile),
            "error_log_file": str(definition.error_logfile),
            "launch_mode": self._launch_mode(),
            "manager": definition.manager,
            "definition": self._serialize_definition(definition),
            "service": definition.service_id,
            "port": definition.ports[0] if definition.ports else None,
            "attached_to_existing": False,
        }

    def _should_replace_existing_service(self, definition: ServiceDefinition) -> bool:
        status = self.supervisor.status(definition)
        if status.get("status") != "running":
            return False

        metadata = status.get("metadata")
        if not isinstance(metadata, dict):
            return False

        recorded_env = metadata.get("env")
        if not isinstance(recorded_env, dict):
            return False

        current_release = str(definition.env.get("SEMIBOT_RELEASE_VERSION") or "").strip()
        running_release = str(recorded_env.get("SEMIBOT_RELEASE_VERSION") or "").strip()
        if current_release and running_release and current_release != running_release:
            return True

        current_runtime_url = str(definition.env.get("RUNTIME_URL") or "").strip()
        running_runtime_url = str(recorded_env.get("RUNTIME_URL") or "").strip()
        if current_runtime_url and running_runtime_url and current_runtime_url != running_runtime_url:
            return True

        current_runtime_port = str(definition.env.get("RUNTIME_PORT") or "").strip()
        running_runtime_port = str(recorded_env.get("RUNTIME_PORT") or "").strip()
        if current_runtime_port and running_runtime_port and current_runtime_port != running_runtime_port:
            return True

        return False

    def _runtime_command(self) -> list[str]:
        return ["bash", str(self.project_root / "runtime" / "scripts" / "launch_runtime.sh")]

    def _runtime_env(self) -> dict[str, str]:
        env = {
            "HOST": self.options.runtime_host,
            "RUNTIME_PORT": str(self.options.runtime_port),
            "RUNTIME_DB_PATH": str(self.options.runtime_db_path or ""),
            "RUNTIME_RULES_PATH": str(self.options.runtime_rules_path or ""),
            **self._release_env(),
        }
        env.update(self._feature_flag_env())
        if self.options.runtime_heartbeat_interval is not None:
            env["RUNTIME_HEARTBEAT_INTERVAL"] = str(self.options.runtime_heartbeat_interval)
        if self.options.runtime_cron_jobs_json:
            env["RUNTIME_CRON_JOBS_JSON"] = self.options.runtime_cron_jobs_json
        return env

    def _ui_command(self, *, service: str) -> list[str]:
        if service == "api":
            script_path = self.project_root / "runtime" / "scripts" / "launch_api.sh"
        elif service == "web":
            script_path = self.project_root / "runtime" / "scripts" / "launch_web.sh"
        else:
            raise RuntimeError(f"unsupported ui service: {service}")
        return ["bash", str(script_path)]

    def _ui_env(self, *, service: str) -> dict[str, str]:
        runtime_base = f"http://127.0.0.1:{self.options.runtime_port}"
        api_base = f"http://127.0.0.1:{self.options.api_port}"
        env_overrides: dict[str, str] = {
            "API_PORT": str(self.options.api_port),
            "WEB_PORT": str(self.options.web_port),
            "HOST": "127.0.0.1",
            **self._release_env(),
            **self._feature_flag_env(),
        }
        if service == "api":
            env_overrides["RUNTIME_PORT"] = str(self.options.runtime_port)
            env_overrides["RUNTIME_URL"] = runtime_base
            env_overrides["VM_DEFAULT_MODE"] = "local" if not self.product_config.feature_flags.get("docker_sandbox_enabled", False) else "docker"
        elif service == "web":
            env_overrides["API_INTERNAL_URL"] = api_base
            env_overrides["NEXT_PUBLIC_API_URL"] = f"{api_base}/api/v1"
            env_overrides["PORT"] = str(self.options.web_port)
        else:
            raise RuntimeError(f"unsupported ui service: {service}")
        return env_overrides

    def _launch_mode(self) -> str:
        if ".semibot/releases" in str(self.project_root):
            return "release"
        return "workspace"

    def _release_env(self) -> dict[str, str]:
        env: dict[str, str] = {}
        active_version = str(self.install_layout.active_release_version() or "").strip()
        if active_version:
            env["SEMIBOT_RELEASE_VERSION"] = active_version
        manifest_url = str(self.product_config.updates.manifest_url or os.getenv("SEMIBOT_UPDATE_MANIFEST_URL") or "").strip()
        if manifest_url:
            env["SEMIBOT_UPDATE_MANIFEST_URL"] = manifest_url
        default_model = str(self.product_config.llm.default_model or "").strip()
        if default_model:
            env["DEFAULT_LLM_MODEL"] = default_model
            inferred_provider = infer_provider_base_from_model(default_model)
            if inferred_provider:
                env["DEFAULT_LLM_PROVIDER_KEY"] = inferred_provider
        openai_api_key = str(self.product_config.llm.openai_api_key or "").strip()
        if openai_api_key:
            env["OPENAI_API_KEY"] = openai_api_key
        anthropic_api_key = str(self.product_config.llm.anthropic_api_key or "").strip()
        if anthropic_api_key:
            env["ANTHROPIC_API_KEY"] = anthropic_api_key
        return env

    def _resolve_execution_root(self) -> Path:
        installed = self.install_layout.installed_workspace_root()
        if installed is not None:
            return installed
        return self.source_root

    def _wait_for_stack_health(self) -> dict[str, Any]:
        deadline = time.monotonic() + max(1.0, self.options.health_timeout_seconds)
        last_services: list[dict[str, Any]] = []
        while time.monotonic() < deadline:
            payload = self.status_payload()
            last_services = list(payload.get("services") or [])
            if self._services_ready(last_services):
                return {
                    "attempted": True,
                    "ready": True,
                    "timeout_seconds": self.options.health_timeout_seconds,
                    "services": last_services,
                }
            time.sleep(1.0)
        return {
            "attempted": True,
            "ready": False,
            "timeout_seconds": self.options.health_timeout_seconds,
            "services": last_services,
        }

    def _format_start_failure(
        self,
        error: RuntimeError,
        *,
        steps: list[dict[str, Any]],
        rollback_steps: list[dict[str, Any]],
        services: list[dict[str, Any]],
        rollback_errors: list[dict[str, Any]] | None = None,
    ) -> str:
        payload = {
            "message": str(error),
            "steps": steps,
            "rollback_steps": rollback_steps,
            "rollback_errors": rollback_errors or [],
            "services": services,
            "diagnostics": self._collect_failure_diagnostics(services),
        }
        return f"stack start failed:\n{self._render_json(payload)}"

    def _format_wait_failure(
        self,
        *,
        wait: dict[str, Any],
        services: list[dict[str, Any]],
        diagnostics: list[dict[str, Any]],
    ) -> str:
        payload = {
            "message": "stack started but did not become healthy before timeout",
            "wait": wait,
            "services": services,
            "diagnostics": diagnostics,
        }
        return f"stack health check failed:\n{self._render_json(payload)}"

    def _collect_failure_diagnostics(self, services: list[dict[str, Any]]) -> list[dict[str, Any]]:
        diagnostics: list[dict[str, Any]] = []
        for service in services:
            diagnostics.append(
                {
                    "service": service.get("service"),
                    "name": service.get("name"),
                    "status": service.get("status"),
                    "log_file": service.get("log_file"),
                    "error_log_file": service.get("error_log_file"),
                    "stderr_tail": self.supervisor.tail(Path(str(service.get("error_log_file") or "")), 20),
                    "stdout_tail": self.supervisor.tail(Path(str(service.get("log_file") or "")), 10),
                }
            )
        return diagnostics

    def _render_json(self, value: dict[str, Any]) -> str:
        import json

        return json.dumps(value, ensure_ascii=False, indent=2)

    def _services_ready(self, services: list[dict[str, Any]]) -> bool:
        if not services:
            return False
        for service in services:
            if service.get("status") in {"stopped", "errored"}:
                return False
            health = service.get("health")
            if isinstance(health, dict) and health.get("status") == "fail":
                return False
        return True

    def _health_checks_for(self, definition: ServiceDefinition) -> list[Any]:
        checks = [probe_port_with_retry("127.0.0.1", port, attempts=3, interval_seconds=0.4) for port in definition.ports]
        for probe in definition.probes:
            if probe.kind == "http":
                checks.append(
                    probe_http_with_retry(
                        probe.target,
                        timeout_seconds=probe.timeout_seconds,
                        attempts=3,
                        interval_seconds=0.4,
                    )
                )
        return checks

    def _tail_file(self, path: Path, lines: int) -> list[str]:
        if not path.exists():
            return []
        try:
            content = path.read_text(encoding="utf-8", errors="replace").splitlines()
        except OSError:
            return []
        if lines <= 0:
            return []
        return content[-lines:]

    def _serialize_definition(self, definition: ServiceDefinition) -> dict[str, Any]:
        return {
            "service_id": definition.service_id,
            "name": definition.name,
            "manager": definition.manager,
            "entrypoint_kind": definition.entrypoint_kind,
            "cwd": str(definition.cwd),
            "command": definition.command,
            "logfile": str(definition.logfile),
            "error_logfile": str(definition.error_logfile),
            "pidfile": str(definition.pidfile),
            "env": definition.env,
            "ports": definition.ports,
            "probes": [
                {"kind": probe.kind, "target": probe.target, "timeout_seconds": probe.timeout_seconds}
                for probe in definition.probes
            ],
        }

    def _open_url_in_browser(self, url: str) -> dict[str, Any]:
        try:
            opened = webbrowser.open(url)
            return {"attempted": True, "opened": bool(opened), "url": url}
        except Exception as exc:
            return {"attempted": True, "opened": False, "url": url, "error": str(exc)}

    def _feature_flag_env(self) -> dict[str, str]:
        flags = self.product_config.feature_flags
        return {
            "SEMIBOT_SQLITE_DEFAULT": "1" if flags.get("sqlite_default", True) else "0",
            "SEMIBOT_POSTGRES_ENABLED": "1" if flags.get("postgres_enabled", False) else "0",
            "SEMIBOT_REDIS_ENABLED": "1" if flags.get("redis_enabled", False) else "0",
            "SEMIBOT_DOCKER_SANDBOX_ENABLED": "1" if flags.get("docker_sandbox_enabled", False) else "0",
        }
