from __future__ import annotations

import os
import socket
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any

from src.bootstrap import ensure_runtime_home
from src.product.config import ProductConfigLoader
from src.product.installer import InstallLayout
from src.product.services import LocalProductStack, StackOptions
from src.product.versioning import resolve_update_payload


def _port_check(*, host: str, port: int, services: list[dict[str, Any]]) -> dict[str, Any]:
    for service in services:
        for candidate in service.get("ports") or []:
            try:
                candidate_port = int(candidate)
            except (TypeError, ValueError):
                continue
            if candidate_port == port:
                return {
                    "name": f"port.{port}",
                    "status": "ok" if service.get("status") == "running" else "warn",
                    "message": f"port {port} belongs to semibot {service.get('service')}",
                }
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        sock.bind((host, port))
    except OSError as exc:
        message = str(exc).lower()
        if exc.errno in {1, 13} or "operation not permitted" in message or "permission denied" in message:
            return {
                "name": f"port.{port}",
                "status": "warn",
                "message": f"port {port} availability could not be verified in this environment: {exc}",
            }
        return {
            "name": f"port.{port}",
            "status": "fail",
            "message": f"port {port} is not available: {exc}",
        }
    finally:
        sock.close()
    return {
        "name": f"port.{port}",
        "status": "ok",
        "message": f"port {port} is available",
    }


def build_product_init_payload(
    *,
    db_path: str,
    rules_path: str,
    runtime_host: str,
    runtime_port: int,
    api_port: int,
    web_port: int,
    default_model: str | None,
    openai_api_key: str | None,
    anthropic_api_key: str | None,
    update_manifest_url: str | None,
    force: bool,
) -> dict[str, Any]:
    loader = ProductConfigLoader()
    product_summary = loader.ensure_layout(
        runtime_host=runtime_host,
        runtime_port=runtime_port,
        api_port=api_port,
        web_port=web_port,
        default_model=default_model,
        openai_api_key=openai_api_key,
        anthropic_api_key=anthropic_api_key,
        update_manifest_url=update_manifest_url,
        force=force,
    )
    runtime_summary = ensure_runtime_home(db_path=db_path, rules_path=rules_path)
    effective = loader.as_dict()
    return {
        "resource": "init",
        "action": "bootstrap",
        "product": product_summary,
        "runtime": runtime_summary,
        "effective_config": effective,
    }


def build_product_doctor_payload(*, db_path: str, rules_path: str, skills_path: str, config_path: str) -> dict[str, Any]:
    loader = ProductConfigLoader()
    product_config = loader.load()
    source_root = Path(__file__).resolve().parents[4]
    db = Path(db_path).expanduser()
    rules = Path(rules_path).expanduser()
    skills = Path(skills_path).expanduser()
    config = Path(config_path).expanduser()

    runtime_checks = {
        "db_path_exists": db.exists(),
        "rules_path_exists": rules.exists(),
        "skills_path_exists": skills.exists(),
        "config_path_exists": config.exists(),
    }

    product_checks = loader.doctor_checks()
    product_writable_checks = loader.writable_checks()
    release_checks = loader.release_checks()
    release_payload = loader.active_release_payload()
    state_snapshot = loader.read_state_snapshot()
    bundled_workspace = bool(release_payload.get("workspace_exists"))
    bundled_node_modules = False
    if bundled_workspace:
        workspace_release = Path(str(release_payload.get("workspace_release") or "")).expanduser()
        bundled_node_modules = (workspace_release / "node_modules").exists()

    dependency_checks = {
        "python_available": bool(sys.executable),
        "python_version_ok": sys.version_info >= (3, 11),
        "node_available": shutil.which("node") is not None,
        "pnpm_available": bundled_node_modules or shutil.which("pnpm") is not None,
        "supervisor_built_in": True,
        "sqlite_default_enabled": bool(product_config.feature_flags.get("sqlite_default", True)),
        "postgres_optional_disabled": not bool(product_config.feature_flags.get("postgres_enabled", False)),
        "redis_optional_disabled": not bool(product_config.feature_flags.get("redis_enabled", False)),
        "docker_sandbox_optional_disabled": not bool(product_config.feature_flags.get("docker_sandbox_enabled", False)),
    }
    if product_config.feature_flags.get("docker_sandbox_enabled", False):
        dependency_checks["docker_available"] = shutil.which("docker") is not None

    recommended_env = {
        "OPENAI_API_KEY": bool(os.getenv("OPENAI_API_KEY")),
        "ANTHROPIC_API_KEY": bool(os.getenv("ANTHROPIC_API_KEY")),
        "TAVILY_API_KEY": bool(os.getenv("TAVILY_API_KEY")),
        "SERPAPI_API_KEY": bool(os.getenv("SERPAPI_API_KEY")),
    }

    stack = LocalProductStack(StackOptions())
    stack_status = stack.status_payload()
    updates = resolve_update_payload(
        manifest_url=product_config.updates.manifest_url,
        current_version=str(release_payload.get("active_version") or "").strip() or None,
    )
    service_entries = stack_status.get("services") or []
    port_checks = {
        "runtime_port": _port_check(
            host=product_config.runtime.host,
            port=product_config.runtime.port,
            services=service_entries,
        ),
        "api_port": _port_check(
            host="127.0.0.1",
            port=product_config.ports.api,
            services=service_entries,
        ),
        "web_port": _port_check(
            host="127.0.0.1",
            port=product_config.ports.web,
            services=service_entries,
        ),
    }
    checks: list[dict[str, Any]] = []
    soft_failures = {"product.state_snapshot_exists"}
    if not release_checks.get("workspace_release_exists") and (source_root / "apps" / "web").exists():
        soft_failures.update(
            {
                "release.active_release_link_exists",
                "release.release_manifest_exists",
                "release.release_build_report_exists",
                "release.workspace_release_exists",
                "release.runtime_release_exists",
                "release.api_release_exists",
                "release.web_release_exists",
            }
        )
    for group_name, group in (
        ("product", product_checks),
        ("product_writable", product_writable_checks),
        ("runtime", runtime_checks),
        ("release", release_checks),
        ("dependency", dependency_checks),
    ):
        for key, value in group.items():
            check_name = f"{group_name}.{key}"
            status = "ok" if value else ("warn" if check_name in soft_failures else "fail")
            checks.append(
                {
                    "name": check_name,
                    "status": status,
                    "message": "passed" if value else ("recommended but not yet generated" if status == "warn" else "missing or unavailable"),
                }
            )
    checks.extend(port_checks.values())
    needs_init = (
        not all(value for key, value in product_checks.items() if key != "state_snapshot_exists")
        or not all(product_writable_checks.values())
        or not all(runtime_checks.values())
    )
    ok = (
        all(runtime_checks.values())
        and all(value for key, value in product_checks.items() if key != "state_snapshot_exists")
        and all(product_writable_checks.values())
        and all(value for key, value in release_checks.items() if key in {"releases_dir_exists"})
        and all(item["status"] != "fail" for item in port_checks.values())
    )
    suggested_actions: list[str] = []
    if not all(product_checks.values()):
        suggested_actions.append("Run `semibot init` to create the install-mode directory layout.")
    if not all(product_writable_checks.values()):
        suggested_actions.append("Ensure `SEMIBOT_HOME` points to a writable directory.")
    if not release_checks["workspace_release_exists"]:
        suggested_actions.append("Build or install a local release so `~/.semibot/releases/current/workspace` exists.")
    if not recommended_env["OPENAI_API_KEY"] and not recommended_env["ANTHROPIC_API_KEY"]:
        suggested_actions.append("Set at least one LLM API key before using chat or run.")
    if not product_config.updates.manifest_url:
        suggested_actions.append("Set `SEMIBOT_UPDATE_MANIFEST_URL` so CLI and Web can detect newer releases.")
    elif updates.get("update_available"):
        suggested_actions.append(str(updates.get("upgrade_command") or "semibot upgrade"))
    if stack_status.get("status") in {"stopped", "degraded"}:
        suggested_actions.append("Run `semibot up` to start the local runtime, API, and Web UI.")
    if not state_snapshot:
        suggested_actions.append("Run `semibot status` after installation to persist a local diagnostic snapshot.")
    for port_check in port_checks.values():
        if port_check["status"] == "fail":
            suggested_actions.append(f"Free {port_check['name'].replace('port.', 'port ')} before starting Semibot services.")
    hint = None
    if not ok:
        if needs_init:
            hint = "Run `semibot init` to bootstrap local runtime home."
        elif stack_status.get("status") in {"stopped", "degraded"}:
            hint = "Run `semibot up` to start the local runtime, API, and Web UI."
        elif suggested_actions:
            hint = suggested_actions[0]

    return {
        "ok": ok,
        "resource": "doctor",
        "action": "diagnose",
        "summary": {
            "status": "healthy" if ok else "needs_attention",
            "failed_checks": len([item for item in checks if item["status"] == "fail"]),
            "warn_checks": len([item for item in checks if item["status"] == "warn"]),
            "service_status": stack_status.get("status"),
            "update_available": bool(updates.get("update_available")),
        },
        "product": {
            "paths": loader.as_dict()["paths"],
            "checks": product_checks,
            "writable_checks": product_writable_checks,
            "release": release_payload,
            "state_snapshot": {
                "path": str(loader.state_snapshot_file()),
                "exists": bool(state_snapshot),
                "updated_at": state_snapshot.get("updated_at") if state_snapshot else None,
            },
        },
        "paths": {
            "db_path": str(db),
            "rules_path": str(rules),
            "skills_path": str(skills),
            "config_path": str(config),
        },
        "runtime_checks": runtime_checks,
        "port_checks": port_checks,
        "dependency_checks": dependency_checks,
        "updates": updates,
        "feature_flags": product_config.feature_flags,
        "release_checks": release_checks,
        "checks": checks,
        "service_status": {
            "status": stack_status.get("status"),
            "services": stack_status.get("services"),
            "service_definitions": stack_status.get("service_definitions"),
            "ui_url": stack_status.get("ui_url"),
            "manager": stack_status.get("manager"),
        },
        "recommended_env": recommended_env,
        "suggested_actions": suggested_actions,
        "hint": hint,
    }


def build_product_upgrade_payload(
    *,
    release_dir: str | None,
    release_url: str | None,
    manifest_url: str | None,
    sha256: str | None,
    version: str | None,
) -> dict[str, Any]:
    loader = ProductConfigLoader()
    install_layout = InstallLayout.discover(loader.paths.home)
    layout = loader.active_release_payload()
    workspace_release = Path(str(layout.get("workspace_release") or "")).expanduser()
    source_root = Path(__file__).resolve().parents[4]
    project_root = workspace_release if workspace_release.exists() else source_root
    install_script = project_root / "scripts" / "install.sh"
    installed_versions = install_layout.installed_versions()

    if version and not release_dir and not release_url and not manifest_url:
        try:
            switch_result = install_layout.switch_active_version(version)
        except FileNotFoundError as exc:
            raise RuntimeError(str(exc)) from exc
        return {
            "ok": True,
            "resource": "upgrade",
            "action": "switch",
            "target_version": version,
            "active_release": loader.active_release_payload(),
            "installed_versions": installed_versions,
            "switch": switch_result,
        }

    if not install_script.exists():
        raise RuntimeError(f"install script not found: {install_script}")

    env = {
        **os.environ,
        "SEMIBOT_HOME": str(loader.paths.home),
    }
    action = "install"
    resolved_release_dir: Path | None = None
    if manifest_url:
        env["SEMIBOT_RELEASE_MANIFEST_URL"] = manifest_url
        env["SEMIBOT_INSTALL_MODE"] = "remote"
        if sha256:
            env["SEMIBOT_RELEASE_SHA256"] = sha256
        action = "manifest-install"
    elif release_url:
        env["SEMIBOT_RELEASE_URL"] = release_url
        env["SEMIBOT_INSTALL_MODE"] = "remote"
        if sha256:
            env["SEMIBOT_RELEASE_SHA256"] = sha256
        action = "download-install"
    else:
        resolved_release_dir = Path(release_dir).expanduser() if release_dir else (project_root / ".release" / "current")
        if not resolved_release_dir.is_absolute():
            resolved_release_dir = (project_root / resolved_release_dir).resolve()
        if not resolved_release_dir.exists():
            raise RuntimeError(f"release directory not found: {resolved_release_dir}")
        env["SEMIBOT_RELEASE_DIR"] = str(resolved_release_dir)
        env["SEMIBOT_INSTALL_MODE"] = "release"

    result = subprocess.run(
        ["bash", str(install_script)],
        capture_output=True,
        text=True,
        env=env,
        cwd=str(project_root),
        check=False,
    )
    if result.returncode != 0:
        raise RuntimeError(
            f"upgrade failed with exit code {result.returncode}\n"
            f"--- stdout ---\n{result.stdout}\n"
            f"--- stderr ---\n{result.stderr}"
        )

    active_release = loader.active_release_payload()
    return {
        "ok": True,
        "resource": "upgrade",
        "action": action,
        "release_dir": str(resolved_release_dir) if resolved_release_dir else None,
        "release_url": release_url,
        "manifest_url": manifest_url,
        "target_version": version,
        "active_release": active_release,
        "installed_versions": install_layout.installed_versions(),
        "stdout_tail": result.stdout.splitlines()[-20:],
        "stderr_tail": result.stderr.splitlines()[-20:],
    }
