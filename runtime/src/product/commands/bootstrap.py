from __future__ import annotations

import hashlib
import ipaddress
import json
import os
import socket
import shutil
import subprocess
import sys
import tarfile
import tempfile
from contextlib import suppress
from pathlib import Path
from typing import Any
from urllib.request import Request, urlopen
import ssl
from urllib.parse import urlparse

from src.bootstrap import ensure_runtime_home
from src.product.config import ProductConfigLoader
from src.product.installer import InstallLayout
from src.product.services import LocalProductStack, StackOptions
from src.product.versioning import resolve_update_payload

try:
    import certifi
except Exception:  # pragma: no cover
    certifi = None


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
    product_config = loader.load()
    install_layout = InstallLayout.discover(loader.paths.home)
    layout = loader.active_release_payload()
    workspace_release = Path(str(layout.get("workspace_release") or "")).expanduser()
    source_root = Path(__file__).resolve().parents[4]
    project_root = workspace_release if workspace_release.exists() else source_root
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

    action = "install"
    resolved_release_dir: Path | None = None
    download_cleanup_root: Path | None = None
    if not release_dir and not release_url and not manifest_url:
        manifest_url = str(product_config.updates.manifest_url or "").strip() or None

    if manifest_url:
        action = "manifest-install"
        resolved_release_dir, download_cleanup_root = _download_release_from_manifest(manifest_url=manifest_url, sha256=sha256)
    elif release_url:
        action = "download-install"
        resolved_release_dir, download_cleanup_root = _download_release_archive(release_url=release_url, sha256=sha256)
    else:
        resolved_release_dir = Path(release_dir).expanduser() if release_dir else (project_root / ".release" / "current")
        if not resolved_release_dir.is_absolute():
            resolved_release_dir = (project_root / resolved_release_dir).resolve()
        if not resolved_release_dir.exists():
            raise RuntimeError(f"release directory not found: {resolved_release_dir}")

    try:
        install_result = _install_release_into_home(
            release_root=resolved_release_dir,
            loader=loader,
            install_layout=install_layout,
        )
    finally:
        if download_cleanup_root is not None:
            shutil.rmtree(download_cleanup_root, ignore_errors=True)

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
        "stdout_tail": install_result.get("stdout_tail") or [],
        "stderr_tail": install_result.get("stderr_tail") or [],
    }


def _ssl_context() -> ssl.SSLContext:
    if certifi is not None:
        return ssl.create_default_context(cafile=certifi.where())
    return ssl.create_default_context()


def _validate_remote_url(url: str, *, field_name: str) -> str:
    value = str(url or "").strip()
    if not value:
        raise RuntimeError(f"{field_name} is required")
    parsed = urlparse(value)
    if parsed.scheme.lower() != "https":
        raise RuntimeError(f"{field_name} must use HTTPS")
    hostname = (parsed.hostname or "").strip().lower()
    if not hostname:
        raise RuntimeError(f"{field_name} host is missing")
    if hostname == "localhost" or hostname.endswith(".localhost"):
        raise RuntimeError(f"{field_name} host is not allowed")
    try:
        address = ipaddress.ip_address(hostname)
    except ValueError:
        return value
    if (
        address.is_private
        or address.is_loopback
        or address.is_link_local
        or address.is_reserved
        or address.is_unspecified
        or address.is_multicast
    ):
        raise RuntimeError(f"{field_name} host is not allowed")
    return value


def _download_json(url: str) -> dict[str, Any]:
    url = _validate_remote_url(url, field_name="manifest URL")
    request = Request(url, headers={"User-Agent": "semibot-upgrade/1"})
    with urlopen(request, timeout=10.0, context=_ssl_context()) as response:
        return json.loads(response.read().decode("utf-8"))


def _download_file(url: str, destination: Path) -> None:
    url = _validate_remote_url(url, field_name="release URL")
    request = Request(url, headers={"User-Agent": "semibot-upgrade/1"})
    with urlopen(request, timeout=60.0, context=_ssl_context()) as response, destination.open("wb") as target:
        shutil.copyfileobj(response, target)


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while True:
            chunk = handle.read(1024 * 1024)
            if not chunk:
                break
            digest.update(chunk)
    return digest.hexdigest()


def _download_release_from_manifest(*, manifest_url: str, sha256: str | None) -> tuple[Path, Path | None]:
    payload = _download_json(manifest_url)
    archive_url = str(payload.get("archive_url") or "").strip()
    if not archive_url:
        raise RuntimeError("release manifest does not contain archive_url")
    archive_sha = str(payload.get("archive_sha256") or "").strip() or None
    return _download_release_archive(release_url=archive_url, sha256=sha256 or archive_sha)


def _download_release_archive(*, release_url: str, sha256: str | None) -> tuple[Path, Path | None]:
    with tempfile.TemporaryDirectory(prefix="semibot-upgrade-") as temp_dir:
        download_root = Path(temp_dir)
        archive_path = download_root / "release.tar.gz"
        extract_root = download_root / "extracted"
        extract_root.mkdir(parents=True, exist_ok=True)

        _download_file(release_url, archive_path)
        if sha256:
            actual = _sha256_file(archive_path)
            if actual != sha256:
                raise RuntimeError(f"sha256 mismatch: expected {sha256}, got {actual}")

        with tarfile.open(archive_path, "r:gz") as archive:
            archive.extractall(extract_root, filter="data")

        candidates = [item for item in extract_root.iterdir() if item.is_dir()]
        if not candidates:
            raise RuntimeError("downloaded archive does not contain a release directory")

        cleanup_root = Path(tempfile.mkdtemp(prefix="semibot-upgrade-release-"))
        copied_release_root = cleanup_root / candidates[0].name
        shutil.copytree(candidates[0], copied_release_root, symlinks=True)
        return copied_release_root, cleanup_root


def _verify_release_root(release_root: Path) -> tuple[dict[str, Any], dict[str, Any]]:
    manifest_file = release_root / "manifest.json"
    build_report_file = release_root / "build-report.json"
    if not manifest_file.exists():
        raise RuntimeError(f"release is missing manifest.json: {manifest_file}")
    if not build_report_file.exists():
        raise RuntimeError(f"release is missing build-report.json: {build_report_file}")
    manifest = json.loads(manifest_file.read_text(encoding="utf-8"))
    build_report = json.loads(build_report_file.read_text(encoding="utf-8"))
    if not build_report.get("ok"):
        raise RuntimeError("release build report is not ok")
    artifact_checks = build_report.get("artifact_checks") or manifest.get("artifact_checks") or {}
    missing = [name for name, ok in artifact_checks.items() if not ok]
    if missing:
        raise RuntimeError(f"release artifact checks failed: {', '.join(missing)}")
    return manifest, build_report


def _install_release_into_home(*, release_root: Path, loader: ProductConfigLoader, install_layout: InstallLayout) -> dict[str, Any]:
    manifest, _build_report = _verify_release_root(release_root)
    version = str(manifest.get("version") or "").strip()
    if not version:
        raise RuntimeError("release manifest does not contain version")

    target_release_dir = install_layout.releases_dir / version
    staging_release_dir = install_layout.releases_dir / f".staging-{version}-{os.getpid()}"
    backup_release_dir = install_layout.releases_dir / f".backup-{version}-{os.getpid()}"
    previous_version = install_layout.active_release_version()
    previous_target = install_layout.active_link.resolve() if install_layout.active_link.exists() else None

    install_layout.releases_dir.mkdir(parents=True, exist_ok=True)
    shutil.rmtree(staging_release_dir, ignore_errors=True)
    shutil.rmtree(backup_release_dir, ignore_errors=True)
    with suppress(FileNotFoundError):
        staging_release_dir.unlink()

    shutil.copytree(release_root, staging_release_dir, symlinks=True)

    if target_release_dir.exists():
        target_release_dir.rename(backup_release_dir)
    staging_release_dir.rename(target_release_dir)
    install_layout.switch_active_version(version)

    runtime_install_script = target_release_dir / "workspace" / "runtime" / "scripts" / "install.sh"
    if not runtime_install_script.exists():
        raise RuntimeError(f"release is missing runtime install script: {runtime_install_script}")

    result = subprocess.run(
        ["bash", str(runtime_install_script)],
        capture_output=True,
        text=True,
        env={**os.environ, "SEMIBOT_HOME": str(loader.paths.home), "SEMIBOT_RELEASE_VERSION": version},
        cwd=str(target_release_dir / "workspace" / "runtime"),
        check=False,
    )
    if result.returncode != 0:
        shutil.rmtree(target_release_dir, ignore_errors=True)
        if backup_release_dir.exists():
            backup_release_dir.rename(target_release_dir)
        if previous_version:
            install_layout.switch_active_version(previous_version)
        elif previous_target:
            tmp_link = install_layout.releases_dir / f".current.rollback-{os.getpid()}.tmp"
            tmp_link.unlink(missing_ok=True)
            tmp_link.symlink_to(previous_target.name)
            tmp_link.replace(install_layout.active_link)
        raise RuntimeError(
            f"upgrade failed with exit code {result.returncode}\n"
            f"--- stdout ---\n{result.stdout}\n"
            f"--- stderr ---\n{result.stderr}"
        )

    shutil.rmtree(backup_release_dir, ignore_errors=True)
    return {
        "stdout_tail": result.stdout.splitlines()[-20:],
        "stderr_tail": result.stderr.splitlines()[-20:],
    }
