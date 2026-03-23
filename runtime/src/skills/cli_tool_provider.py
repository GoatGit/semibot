"""CLI tool manifest discovery and execution helpers."""

from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from src.skills.base import BaseTool, ToolResult
from src.skills.registry import SkillMetadata, SkillRegistry
from src.utils.logging import get_logger

try:
    from jsonschema import ValidationError, validate as jsonschema_validate
except Exception:  # pragma: no cover - optional dependency
    ValidationError = Exception  # type: ignore[assignment]
    jsonschema_validate = None

logger = get_logger(__name__)

_DEFAULT_TIMEOUT_SECONDS = 60


@dataclass(frozen=True)
class CliToolManifest:
    package_id: str
    skill_dir: Path
    manifest_path: Path
    tool_id: str
    provider_id: str
    tool_name: str
    description: str
    command: list[str]
    parameters: dict[str, Any]
    json_mode: bool
    output_schema: dict[str, Any]
    stderr_policy: str
    nonzero_exit_policy: str
    timeout_seconds: int
    metadata: dict[str, Any]


def _validate_stdout_payload(data: Any, schema: dict[str, Any]) -> tuple[bool, str | None]:
    if not schema:
        return True, None
    if jsonschema_validate is None:
        expected = schema.get("type") if isinstance(schema, dict) else None
        if expected == "object" and not isinstance(data, dict):
            return False, "CLI stdout JSON is not an object"
        required = schema.get("required") if isinstance(schema, dict) else None
        if isinstance(required, list):
            missing = [key for key in required if isinstance(key, str) and key not in data]
            if missing:
                return False, f"CLI stdout JSON missing required fields: {', '.join(missing)}"
        return True, None
    try:
        jsonschema_validate(instance=data, schema=schema)
        return True, None
    except ValidationError as exc:  # pragma: no cover - optional dependency
        return False, str(exc)


def _load_manifest(path: Path, *, package_id: str) -> CliToolManifest | None:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:
        logger.warning("cli_tool_manifest_load_failed", extra={"path": str(path), "error": str(exc)})
        return None
    if not isinstance(payload, dict):
        return None

    tool_name = str(payload.get("tool_name") or "").strip()
    description = str(payload.get("description") or "").strip()
    command = payload.get("command")
    parameters = payload.get("parameters")
    if not tool_name or not description or not isinstance(command, list) or not command:
        logger.warning("cli_tool_manifest_invalid", extra={"path": str(path), "reason": "missing_required_fields"})
        return None
    command_items: list[str] = []
    for item in command:
        if not isinstance(item, str) or not item.strip():
            logger.warning("cli_tool_manifest_invalid", extra={"path": str(path), "reason": "invalid_command_item"})
            return None
        command_items.append(item)
    if len(command_items) >= 2:
        launcher = command_items[0].strip().lower()
        shell_flag = command_items[1].strip()
        if launcher in {"bash", "sh", "zsh"} and shell_flag == "-c":
            logger.warning("cli_tool_manifest_invalid", extra={"path": str(path), "reason": "shell_trampoline_not_allowed"})
            return None

    timeout_raw = payload.get("timeout_seconds")
    timeout_seconds = _DEFAULT_TIMEOUT_SECONDS
    if isinstance(timeout_raw, int) and timeout_raw > 0:
        timeout_seconds = timeout_raw

    output_schema = payload.get("output_schema") if isinstance(payload.get("output_schema"), dict) else {}
    metadata = {
        "tool_id": str(payload.get("tool_id") or f"cli:{package_id}:{tool_name}"),
        "provider_id": str(payload.get("provider_id") or package_id).strip() or package_id,
        "stderr_policy": str(payload.get("stderr_policy") or "log_only").strip() or "log_only",
        "nonzero_exit_policy": str(payload.get("nonzero_exit_policy") or "error").strip() or "error",
        "risk_level": str(payload.get("risk_level") or "medium").strip() or "medium",
        "needs_browser": bool(payload.get("needs_browser")),
        "needs_auth": bool(payload.get("needs_auth")),
        "json_mode": bool(payload.get("json_mode")),
        "timeout_seconds": timeout_seconds,
        "output_schema": output_schema,
    }
    return CliToolManifest(
        package_id=package_id,
        skill_dir=path.parent.parent,
        manifest_path=path,
        tool_id=metadata["tool_id"],
        provider_id=metadata["provider_id"],
        tool_name=tool_name,
        description=description,
        command=command_items,
        parameters=dict(parameters) if isinstance(parameters, dict) else {"type": "object", "properties": {}},
        json_mode=metadata["json_mode"],
        output_schema=output_schema,
        stderr_policy=metadata["stderr_policy"],
        nonzero_exit_policy=metadata["nonzero_exit_policy"],
        timeout_seconds=timeout_seconds,
        metadata=metadata,
    )


def discover_cli_manifests(skills_root: Path, package_rows: dict[str, dict[str, Any]]) -> list[CliToolManifest]:
    manifests: list[CliToolManifest] = []
    for package_id, row in package_rows.items():
        skill_dir_raw = str(row.get("installed_path") or "").strip()
        if not skill_dir_raw:
            continue
        skill_dir = Path(skill_dir_raw).expanduser()
        cli_dir = skill_dir / "cli-tools"
        if not cli_dir.exists() or not cli_dir.is_dir():
            continue
        for candidate in sorted(cli_dir.glob("*.json")):
            manifest = _load_manifest(candidate, package_id=package_id)
            if manifest is not None:
                manifests.append(manifest)
    return manifests


class CliManifestTool(BaseTool):
    def __init__(self, manifest: CliToolManifest) -> None:
        self._manifest = manifest

    @property
    def name(self) -> str:
        return self._manifest.tool_name

    @property
    def description(self) -> str:
        return self._manifest.description

    @property
    def parameters(self) -> dict[str, Any]:
        return self._manifest.parameters

    def _substitute_command(self, params: dict[str, Any]) -> list[str]:
        values: dict[str, str] = {
            "skill_dir": str(self._manifest.skill_dir),
            "package_id": self._manifest.package_id,
        }
        for key, value in params.items():
            if isinstance(value, (dict, list)):
                values[key] = json.dumps(value, ensure_ascii=False)
            elif value is None:
                values[key] = ""
            else:
                values[key] = str(value)
        rendered: list[str] = []
        for item in self._manifest.command:
            rendered.append(item.format(**values))
        return rendered

    async def execute(self, **kwargs: Any) -> ToolResult:
        try:
            command = self._substitute_command(kwargs)
        except KeyError as exc:
            return ToolResult.error_result(
                f"CLI command template is missing parameter: {exc.args[0]}",
                tool_id=self._manifest.tool_id,
                source_type="cli",
                provider_id=self._manifest.provider_id,
                package_id=self._manifest.package_id,
                error_type="invalid_command_template",
            )
        except ValueError as exc:
            return ToolResult.error_result(
                f"CLI command template is invalid: {exc}",
                tool_id=self._manifest.tool_id,
                source_type="cli",
                provider_id=self._manifest.provider_id,
                package_id=self._manifest.package_id,
                error_type="invalid_command_template",
            )
        try:
            proc = await asyncio.create_subprocess_exec(
                *command,
                cwd=str(self._manifest.skill_dir),
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
        except FileNotFoundError as exc:
            return ToolResult.error_result(
                f"CLI executable not found: {command[0]}",
                tool_id=self._manifest.tool_id,
                source_type="cli",
                command=command,
                error_type="not_found",
                exception=str(exc),
            )

        try:
            stdout_bytes, stderr_bytes = await asyncio.wait_for(proc.communicate(), timeout=self._manifest.timeout_seconds)
        except asyncio.TimeoutError:
            proc.terminate()
            try:
                await asyncio.wait_for(proc.wait(), timeout=2)
            except asyncio.TimeoutError:
                proc.kill()
                await proc.wait()
            return ToolResult.error_result(
                f"CLI tool timed out after {self._manifest.timeout_seconds}s",
                tool_id=self._manifest.tool_id,
                source_type="cli",
                command=command,
                error_type="timeout",
            )

        stdout_text = stdout_bytes.decode("utf-8", errors="replace").strip()
        stderr_text = stderr_bytes.decode("utf-8", errors="replace").strip()
        metadata = {
            "tool_id": self._manifest.tool_id,
            "source_type": "cli",
            "provider_id": self._manifest.provider_id,
            "package_id": self._manifest.package_id,
            "command": command,
            "exit_code": proc.returncode,
        }
        if stderr_text:
            metadata["stderr"] = stderr_text

        if stderr_text and self._manifest.stderr_policy == "error_if_nonempty":
            return ToolResult.error_result(
                "CLI tool wrote to stderr",
                **metadata,
                error_type="stderr",
                stdout=stdout_text,
            )

        if proc.returncode != 0 and self._manifest.nonzero_exit_policy == "error":
            return ToolResult.error_result(
                f"CLI tool exited with code {proc.returncode}",
                **metadata,
                error_type="nonzero_exit",
                stdout=stdout_text,
            )

        if not self._manifest.json_mode:
            return ToolResult.success_result(stdout_text, **metadata)

        try:
            payload = json.loads(stdout_text or "{}")
        except json.JSONDecodeError as exc:
            return ToolResult.error_result(
                "CLI tool returned invalid JSON",
                **metadata,
                error_type="invalid_json",
                stdout=stdout_text,
                exception=str(exc),
            )
        valid, validation_error = _validate_stdout_payload(payload, self._manifest.output_schema)
        if not valid:
            return ToolResult.error_result(
                "CLI tool JSON output failed schema validation",
                **metadata,
                error_type="invalid_output_schema",
                stdout_json=payload,
                validation_error=validation_error,
            )
        if isinstance(payload, dict) and payload.get("ok") is False:
            return ToolResult.error_result(
                str(payload.get("error") or "CLI tool reported failure"),
                **metadata,
                error_type="cli_error",
                stdout_json=payload,
            )
        result = payload.get("data") if isinstance(payload, dict) and "data" in payload else payload
        return ToolResult.success_result(result, **metadata, stdout_json=payload)


def register_cli_manifest_tools(
    registry: SkillRegistry,
    *,
    skills_root: Path,
    package_rows: dict[str, dict[str, Any]],
) -> dict[str, Any]:
    manifests = discover_cli_manifests(skills_root, package_rows)
    active_packages = set(package_rows.keys())
    active_tool_names_by_package: dict[str, set[str]] = {}
    for manifest in manifests:
        active_tool_names_by_package.setdefault(manifest.package_id, set()).add(manifest.tool_name)

    removed: list[str] = []
    for tool_name in list(registry.list_tools()):
        metadata = registry.get_tool_metadata(tool_name)
        if not metadata or metadata.source != "cli":
            continue
        package_id = str(metadata.additional.get("package_id") or "").strip()
        active_names = active_tool_names_by_package.get(package_id, set())
        if not package_id or package_id not in active_packages or tool_name not in active_names:
            registry.unregister_tool(tool_name)
            removed.append(tool_name)

    registered: list[str] = []
    skipped: list[dict[str, str]] = []
    for manifest in manifests:
        try:
            existing_metadata = registry.get_tool_metadata(manifest.tool_name)
            if existing_metadata and existing_metadata.source != "cli":
                skipped.append({"name": manifest.tool_name, "reason": "conflicts_with_non_cli_tool"})
                logger.warning(
                    "cli_tool_registration_skipped",
                    extra={
                        "tool_name": manifest.tool_name,
                        "manifest_path": str(manifest.manifest_path),
                        "reason": "conflicts_with_non_cli_tool",
                    },
                )
                continue
            registry.register_tool(
                CliManifestTool(manifest),
                SkillMetadata(
                    source="cli",
                    tags=["cli"],
                    additional={
                        "source_type": "cli",
                        "package_id": manifest.package_id,
                        "provider_id": manifest.provider_id,
                        "tool_id": manifest.tool_id,
                        "manifest_path": str(manifest.manifest_path),
                        "installed_path": str(manifest.skill_dir),
                    },
                ),
            )
            registered.append(manifest.tool_name)
        except Exception as exc:
            skipped.append({"name": manifest.tool_name, "reason": str(exc)})
            logger.warning(
                "cli_tool_registration_failed",
                extra={"tool_name": manifest.tool_name, "manifest_path": str(manifest.manifest_path), "error": str(exc)},
            )

    return {
        "skills_root": str(skills_root),
        "registered": registered,
        "removed": removed,
        "skipped": skipped,
        "manifest_count": len(manifests),
    }
