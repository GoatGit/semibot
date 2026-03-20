from __future__ import annotations

import json
import os
import signal
import subprocess
import time
from dataclasses import asdict
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from .manager import ServiceManager
from .model import ServiceDefinition


class LocalSupervisor(ServiceManager):
    """Minimal local process supervisor backed by pid and metadata files."""

    def status(self, definition: ServiceDefinition) -> dict[str, Any]:
        pid = self._read_pid(definition.pidfile)
        running = self._is_running(pid)
        if pid is not None and not running:
            self._cleanup(definition)
        meta = self._read_meta(self._meta_path(definition.pidfile))
        return {
            "name": definition.name,
            "status": "running" if running else "stopped",
            "pid": pid if running else None,
            "metadata": meta,
        }

    def start(self, definition: ServiceDefinition, *, replace_existing: bool = False) -> dict[str, Any]:
        existing = self.status(definition)
        replaced = False
        if existing.get("status") == "running":
            if not replace_existing:
                return {
                    "name": definition.name,
                    "pid": existing.get("pid"),
                    "already_running": True,
                    "manager": definition.manager,
                }
            self.stop(definition)
            replaced = True

        definition.pidfile.parent.mkdir(parents=True, exist_ok=True)
        definition.logfile.parent.mkdir(parents=True, exist_ok=True)
        definition.error_logfile.parent.mkdir(parents=True, exist_ok=True)

        stdout_handle = definition.logfile.open("a", encoding="utf-8")
        try:
            stderr_handle = definition.error_logfile.open("a", encoding="utf-8")
        except Exception:
            stdout_handle.close()
            raise
        try:
            process = subprocess.Popen(
                definition.command,
                cwd=str(definition.cwd),
                env={**os.environ, **definition.env},
                stdout=stdout_handle,
                stderr=stderr_handle,
                start_new_session=True,
            )
        finally:
            stdout_handle.close()
            stderr_handle.close()

        try:
            definition.pidfile.write_text(f"{process.pid}\n", encoding="utf-8")
            self._meta_path(definition.pidfile).write_text(
                json.dumps(
                    {
                        "name": definition.name,
                        "service_id": definition.service_id,
                        "pid": process.pid,
                        "command": definition.command,
                        "cwd": str(definition.cwd),
                        "env": definition.env,
                        "started_at": datetime.now(UTC).isoformat(),
                    },
                    indent=2,
                )
                + "\n",
                encoding="utf-8",
            )
        except Exception:
            self._terminate(process.pid)
            time.sleep(0.2)
            if self._is_running(process.pid):
                self._kill(process.pid)
                time.sleep(0.2)
            self._cleanup(definition)
            raise

        time.sleep(0.2)
        exit_code = process.poll()
        if exit_code is not None:
            stderr_tail = self.tail(definition.error_logfile, 20)
            self._cleanup(definition)
            detail = f"service `{definition.name}` exited immediately with code {exit_code}; see {definition.error_logfile}"
            if stderr_tail:
                detail = f"{detail}\n--- stderr tail ---\n" + "\n".join(stderr_tail)
            raise RuntimeError(detail)

        return {
            "name": definition.name,
            "pid": process.pid,
            "replaced_existing": replaced,
            "manager": definition.manager,
        }

    def stop(self, definition: ServiceDefinition, *, timeout_seconds: float = 10.0) -> dict[str, Any]:
        pid = self._read_pid(definition.pidfile)
        if pid is None or not self._is_running(pid):
            self._cleanup(definition)
            return {"name": definition.name, "already_stopped": True}

        self._terminate(pid)
        deadline = time.monotonic() + max(1.0, timeout_seconds)
        while time.monotonic() < deadline:
            if not self._is_running(pid):
                self._cleanup(definition)
                return {"name": definition.name, "stopped": True, "pid": pid}
            time.sleep(0.2)

        self._kill(pid)
        time.sleep(0.2)
        self._cleanup(definition)
        return {"name": definition.name, "stopped": True, "pid": pid, "forced": True}

    def restart(self, definition: ServiceDefinition) -> dict[str, Any]:
        stop_detail = self.stop(definition)
        start_detail = self.start(definition)
        return {"stop": stop_detail, "start": start_detail}

    def tail(self, path: Path, lines: int = 20) -> list[str]:
        if lines <= 0:
            return []
        try:
            content = path.read_text(encoding="utf-8", errors="replace").splitlines()
        except OSError:
            return []
        return content[-lines:]

    def _terminate(self, pid: int) -> None:
        try:
            os.killpg(pid, signal.SIGTERM)
            return
        except Exception:
            pass
        try:
            os.kill(pid, signal.SIGTERM)
        except ProcessLookupError:
            pass

    def _kill(self, pid: int) -> None:
        try:
            os.killpg(pid, signal.SIGKILL)
            return
        except Exception:
            pass
        try:
            os.kill(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass

    def _is_running(self, pid: int | None) -> bool:
        if pid is None or pid <= 0:
            return False
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            return False
        except PermissionError:
            return True
        return True

    def _read_pid(self, path: Path) -> int | None:
        try:
            raw = path.read_text(encoding="utf-8").strip()
        except OSError:
            return None
        if not raw:
            return None
        try:
            return int(raw)
        except ValueError:
            return None

    def _read_meta(self, path: Path) -> dict[str, Any] | None:
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            return None
        return raw if isinstance(raw, dict) else None

    def _meta_path(self, pidfile: Path) -> Path:
        return pidfile.with_suffix(f"{pidfile.suffix}.json")

    def _cleanup(self, definition: ServiceDefinition) -> None:
        for path in (definition.pidfile, self._meta_path(definition.pidfile)):
            try:
                path.unlink()
            except FileNotFoundError:
                pass
