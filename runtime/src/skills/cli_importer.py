"""CLI import, contract extraction, persistence registration, and execution."""

from __future__ import annotations

import asyncio
import json
import re
import shutil
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal

from src.skills.base import BaseTool, ToolResult
from src.skills.cli_tool_provider import _validate_stdout_payload
from src.skills.registry import SkillMetadata, SkillRegistry
from src.utils.logging import get_logger

logger = get_logger(__name__)

CliImportShape = Literal["direct", "group"]
CliImportSource = Literal["cli", "web", "channel_auto"]

_DEFAULT_TIMEOUT_SECONDS = 60
_BANNED_LAUNCHERS = {"bash", "sh", "zsh"}


@dataclass(frozen=True)
class ImportedCliAction:
    command: str
    description: str
    parameters: dict[str, Any]
    command_template: list[str]
    output_schema: dict[str, Any]
    json_mode: bool


@dataclass(frozen=True)
class ImportedCliSpec:
    tool_name: str
    display_name: str
    description: str
    shape: CliImportShape
    entry_command: list[str]
    parameters: dict[str, Any]
    command_template: list[str] | None
    action_templates: dict[str, list[str]]
    actions: list[ImportedCliAction]
    output_schema: dict[str, Any]
    json_mode: bool
    risk_level: str
    timeout_seconds: int
    resolved_command_path: str | None
    metadata: dict[str, Any]

    def to_config(self) -> dict[str, Any]:
        return {
            "shape": self.shape,
            "entryCommand": list(self.entry_command),
            "commandTemplate": list(self.command_template or []),
            "actionTemplates": {key: list(value) for key, value in self.action_templates.items()},
            "actions": [
                {
                    "command": item.command,
                    "description": item.description,
                    "parameters": item.parameters,
                    "commandTemplate": item.command_template,
                    "outputSchema": item.output_schema,
                    "jsonMode": item.json_mode,
                }
                for item in self.actions
            ],
            "outputSchema": self.output_schema,
            "jsonMode": self.json_mode,
            "riskLevel": self.risk_level,
            "timeoutSeconds": self.timeout_seconds,
            "resolvedCommandPath": self.resolved_command_path,
            "metadata": dict(self.metadata),
        }


def _slug(value: str) -> str:
    return re.sub(r"_+", "_", re.sub(r"[^a-zA-Z0-9]+", "_", str(value or "").strip())).strip("_").lower() or "tool"


def _normalize_param_name(token: str) -> str:
    return _slug(token).replace("-", "_")


def _validate_entry_command(command: list[str]) -> None:
    if not command or not all(isinstance(item, str) and item.strip() for item in command):
        raise ValueError("command prefix is required")
    if command[0].strip().lower() in _BANNED_LAUNCHERS:
        raise ValueError(f"banned launcher: {command[0]}")
    if len(command) >= 2 and command[0].strip().lower() in _BANNED_LAUNCHERS and command[1].strip() == "-c":
        raise ValueError("shell trampoline is not allowed")


def _resolve_executable(command: list[str]) -> str | None:
    first = str(command[0] or "").strip()
    if not first:
        return None
    if "/" in first:
        path = Path(first).expanduser()
        return str(path.resolve()) if path.exists() else None
    return shutil.which(first)


async def _run_help(command: list[str]) -> str:
    proc = await asyncio.create_subprocess_exec(
        *command,
        "--help",
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    stdout_bytes, stderr_bytes = await proc.communicate()
    text = stdout_bytes.decode("utf-8", errors="replace")
    stderr_text = stderr_bytes.decode("utf-8", errors="replace")
    output = text.strip() or stderr_text.strip()
    if proc.returncode != 0 or not output:
        raise ValueError(f"help command failed for: {' '.join(command)}")
    return output


def _find_usage_line(help_text: str, command: list[str]) -> str:
    joined = " ".join(command).strip()
    for line in help_text.splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        lowered = stripped.lower()
        if lowered.startswith("usage:"):
            return stripped
        if joined and stripped.startswith(joined):
            return stripped
    return ""


def _parse_usage_tokens(usage_line: str, command: list[str]) -> list[str]:
    if not usage_line:
        return []
    text = usage_line
    if text.lower().startswith("usage:"):
        text = text.split(":", 1)[1].strip()
    joined = " ".join(command).strip()
    if joined and text.startswith(joined):
        text = text[len(joined) :].strip()
    tokens: list[str] = []
    for match in re.finditer(r"<([^>]+)>", text):
        token = _normalize_param_name(match.group(1))
        if token:
            tokens.append(token)
    return tokens


def _detect_json_flag(help_text: str) -> str | None:
    """Detect which CLI flag enables JSON output.

    Returns the flag tokens to append (e.g. ``"--json"`` or ``"--format json"``),
    or ``None`` if the help text does not advertise JSON output.
    """
    text = help_text.lower()
    if "--json" in text:
        return "--json"
    # opencli-style: -f, --format <fmt>  Output format: table, json, ...
    if re.search(r"--format\b.*\bjson\b", text):
        return "--format json"
    return None


def _supports_json_output(help_text: str) -> bool:
    return _detect_json_flag(help_text) is not None


def _extract_group_commands(help_text: str) -> list[tuple[str, str]]:
    results: list[tuple[str, str]] = []
    in_commands = False
    for raw_line in help_text.splitlines():
        line = raw_line.rstrip()
        stripped = line.strip()
        if not stripped:
            if in_commands:
                break
            continue
        if stripped.lower().startswith("commands:"):
            in_commands = True
            continue
        if not in_commands:
            continue
        match = re.match(r"^\s{2,}([a-zA-Z0-9][\w-]*)\s+(.*)$", line)
        if not match:
            if in_commands and not raw_line.startswith(" "):
                break
            continue
        command = str(match.group(1)).strip()
        if command == "help":
            continue
        description = str(match.group(2)).strip()
        results.append((command, description))
    return results


def _build_object_schema(required_tokens: list[str]) -> dict[str, Any]:
    return {
        "type": "object",
        "properties": {token: {"type": "string", "minLength": 1} for token in required_tokens},
        "required": list(required_tokens),
        "additionalProperties": False,
    }


def _build_tool_name(command: list[str]) -> str:
    return "_".join(_slug(part) for part in command if str(part or "").strip())


async def extract_direct_cli_spec(
    command: list[str],
    *,
    tool_name: str | None = None,
    display_name: str | None = None,
    description: str | None = None,
) -> ImportedCliSpec:
    _validate_entry_command(command)
    help_text = await _run_help(command)
    usage_line = _find_usage_line(help_text, command)
    required_tokens = _parse_usage_tokens(usage_line, command)
    json_mode = _supports_json_output(help_text)
    json_flag = _detect_json_flag(help_text)
    command_template = list(command)
    for token in required_tokens:
        command_template.append("{" + token + "}")
    if json_flag:
        command_template.extend(json_flag.split())
    final_tool_name = tool_name or _build_tool_name(command)
    final_display_name = display_name or " ".join(command)
    final_description = description or help_text.splitlines()[0].strip() or final_display_name
    return ImportedCliSpec(
        tool_name=final_tool_name,
        display_name=final_display_name,
        description=final_description,
        shape="direct",
        entry_command=list(command),
        parameters=_build_object_schema(required_tokens),
        command_template=command_template,
        action_templates={},
        actions=[],
        output_schema={},
        json_mode=json_mode,
        risk_level="medium",
        timeout_seconds=_DEFAULT_TIMEOUT_SECONDS,
        resolved_command_path=_resolve_executable(command),
        metadata={"source_type": "cli", "provider_id": _slug(command[0]), "shape": "direct"},
    )


async def extract_group_cli_spec(
    command: list[str],
    *,
    tool_name: str | None = None,
    display_name: str | None = None,
    description: str | None = None,
) -> ImportedCliSpec:
    _validate_entry_command(command)
    help_text = await _run_help(command)
    commands = _extract_group_commands(help_text)
    if not commands:
        raise ValueError("command group help does not expose subcommands")

    action_templates: dict[str, list[str]] = {}
    one_of: list[dict[str, Any]] = []
    actions: list[ImportedCliAction] = []
    for action_name, action_description in commands:
        leaf_prefix = [*command, action_name]
        leaf_help = await _run_help(leaf_prefix)
        usage_line = _find_usage_line(leaf_help, leaf_prefix)
        required_tokens = _parse_usage_tokens(usage_line, leaf_prefix)
        json_mode = _supports_json_output(leaf_help)
        json_flag = _detect_json_flag(leaf_help)
        action_template = list(leaf_prefix)
        for token in required_tokens:
            action_template.append("{" + token + "}")
        if json_flag:
            action_template.extend(json_flag.split())
        action_templates[action_name] = action_template
        branch_properties: dict[str, Any] = {
            "command": {"const": action_name},
        }
        for token in required_tokens:
            branch_properties[token] = {"type": "string", "minLength": 1}
        one_of.append(
            {
                "type": "object",
                "properties": branch_properties,
                "required": ["command", *required_tokens],
                "additionalProperties": False,
            }
        )
        actions.append(
            ImportedCliAction(
                command=action_name,
                description=action_description or leaf_help.splitlines()[0].strip(),
                parameters=_build_object_schema(required_tokens),
                command_template=action_template,
                output_schema={},
                json_mode=json_mode,
            )
        )

    final_tool_name = tool_name or _build_tool_name(command)
    final_display_name = display_name or " ".join(command)
    final_description = description or help_text.splitlines()[0].strip() or final_display_name
    return ImportedCliSpec(
        tool_name=final_tool_name,
        display_name=final_display_name,
        description=final_description,
        shape="group",
        entry_command=list(command),
        parameters={"type": "object", "oneOf": one_of, "additionalProperties": False},
        command_template=None,
        action_templates=action_templates,
        actions=actions,
        output_schema={},
        json_mode=False,
        risk_level="medium",
        timeout_seconds=_DEFAULT_TIMEOUT_SECONDS,
        resolved_command_path=_resolve_executable(command),
        metadata={"source_type": "cli", "provider_id": _slug(command[0]), "shape": "group"},
    )


async def extract_cli_spec(
    *,
    command: list[str],
    shape: CliImportShape,
    tool_name: str | None = None,
    display_name: str | None = None,
    description: str | None = None,
) -> ImportedCliSpec:
    if shape == "group":
        return await extract_group_cli_spec(
            command,
            tool_name=tool_name,
            display_name=display_name,
            description=description,
        )
    return await extract_direct_cli_spec(
        command,
        tool_name=tool_name,
        display_name=display_name,
        description=description,
    )


class ImportedCliTool(BaseTool):
    def __init__(self, spec: ImportedCliSpec) -> None:
        self._spec = spec

    @property
    def name(self) -> str:
        return self._spec.tool_name

    @property
    def description(self) -> str:
        return self._spec.description

    @property
    def parameters(self) -> dict[str, Any]:
        return self._spec.parameters

    def _render_command(self, params: dict[str, Any]) -> tuple[list[str], bool, dict[str, Any]]:
        values: dict[str, str] = {}
        for key, value in params.items():
            if isinstance(value, (dict, list)):
                values[key] = json.dumps(value, ensure_ascii=False)
            elif value is None:
                values[key] = ""
            else:
                values[key] = str(value)
        metadata: dict[str, Any] = {}
        if self._spec.shape == "group":
            command_name = str(params.get("command") or "").strip()
            template = self._spec.action_templates.get(command_name)
            if not template:
                raise ValueError(f"unsupported command: {command_name}")
            action = next((item for item in self._spec.actions if item.command == command_name), None)
            metadata["command"] = command_name
            return [part.format(**values) for part in template], bool(action.json_mode if action else False), metadata
        if not self._spec.command_template:
            raise ValueError("missing command template")
        return [part.format(**values) for part in self._spec.command_template], self._spec.json_mode, metadata

    async def execute(self, **kwargs: Any) -> ToolResult:
        try:
            command, json_mode, extra_metadata = self._render_command(kwargs)
        except KeyError as exc:
            return ToolResult.error_result(
                f"CLI command template is missing parameter: {exc.args[0]}",
                tool_id=f"cli:{self._spec.metadata.get('provider_id')}:{self._spec.tool_name}",
                source_type="cli",
                provider_id=self._spec.metadata.get("provider_id"),
                error_type="invalid_command_template",
            )
        except ValueError as exc:
            return ToolResult.error_result(
                str(exc),
                tool_id=f"cli:{self._spec.metadata.get('provider_id')}:{self._spec.tool_name}",
                source_type="cli",
                provider_id=self._spec.metadata.get("provider_id"),
                error_type="invalid_command",
            )

        try:
            proc = await asyncio.create_subprocess_exec(
                *command,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
        except FileNotFoundError as exc:
            return ToolResult.error_result(
                f"CLI executable not found: {command[0]}",
                source_type="cli",
                provider_id=self._spec.metadata.get("provider_id"),
                error_type="not_found",
                exception=str(exc),
                command=command,
            )
        try:
            stdout_bytes, stderr_bytes = await asyncio.wait_for(proc.communicate(), timeout=self._spec.timeout_seconds)
        except asyncio.TimeoutError:
            proc.terminate()
            try:
                await asyncio.wait_for(proc.wait(), timeout=2)
            except asyncio.TimeoutError:
                proc.kill()
                await proc.wait()
            return ToolResult.error_result(
                f"CLI tool timed out after {self._spec.timeout_seconds}s",
                source_type="cli",
                provider_id=self._spec.metadata.get("provider_id"),
                error_type="timeout",
                command=command,
            )

        stdout_text = stdout_bytes.decode("utf-8", errors="replace").strip()
        stderr_text = stderr_bytes.decode("utf-8", errors="replace").strip()
        metadata: dict[str, Any] = {
            "source_type": "cli",
            "provider_id": self._spec.metadata.get("provider_id"),
            "shape": self._spec.shape,
            "command": command,
            "exit_code": proc.returncode,
            **extra_metadata,
        }
        if stderr_text:
            metadata["stderr"] = stderr_text
        if proc.returncode != 0:
            return ToolResult.error_result(
                f"CLI tool exited with code {proc.returncode}",
                error_type="command_failed",
                stdout=stdout_text,
                **metadata,
            )
        if not json_mode:
            return ToolResult.success_result(stdout_text, **metadata)
        try:
            payload = json.loads(stdout_text or "null")
        except json.JSONDecodeError as exc:
            return ToolResult.error_result(
                f"CLI stdout is not valid JSON: {exc}",
                error_type="invalid_json",
                stdout=stdout_text,
                **metadata,
            )
        schema = self._spec.output_schema
        if self._spec.shape == "group":
            action_name = str(extra_metadata.get("command") or "").strip()
            action = next((item for item in self._spec.actions if item.command == action_name), None)
            schema = action.output_schema if action else {}
        ok, error = _validate_stdout_payload(payload, schema)
        if not ok:
            return ToolResult.error_result(
                error or "CLI stdout JSON does not match schema",
                error_type="invalid_output_schema",
                stdout=stdout_text,
                **metadata,
            )
        return ToolResult.success_result(payload, **metadata)


def _spec_from_tool_row(row: dict[str, Any]) -> ImportedCliSpec | None:
    if not isinstance(row, dict):
        return None
    config = row.get("config") if isinstance(row.get("config"), dict) else {}
    entry_command = [str(item) for item in config.get("entryCommand") or [] if str(item or "").strip()]
    if not entry_command:
        return None
    shape = str(config.get("shape") or "direct").strip().lower()
    actions: list[ImportedCliAction] = []
    for item in config.get("actions") or []:
        if not isinstance(item, dict):
            continue
        actions.append(
            ImportedCliAction(
                command=str(item.get("command") or "").strip(),
                description=str(item.get("description") or "").strip(),
                parameters=item.get("parameters") if isinstance(item.get("parameters"), dict) else {"type": "object", "properties": {}, "additionalProperties": False},
                command_template=[str(part) for part in item.get("commandTemplate") or [] if str(part or "").strip()],
                output_schema=item.get("outputSchema") if isinstance(item.get("outputSchema"), dict) else {},
                json_mode=bool(item.get("jsonMode")),
            )
        )
    metadata = config.get("metadata") if isinstance(config.get("metadata"), dict) else {}
    provider_id = str(metadata.get("provider_id") or _slug(entry_command[0])).strip() or _slug(entry_command[0])
    metadata = {"source_type": "cli", "provider_id": provider_id, **metadata}
    return ImportedCliSpec(
        tool_name=str(row.get("name") or "").strip(),
        display_name=str(config.get("displayName") or row.get("name") or "").strip() or str(row.get("name") or "").strip(),
        description=str(row.get("description") or "").strip() or str(config.get("displayName") or row.get("name") or "").strip(),
        shape="group" if shape == "group" else "direct",
        entry_command=entry_command,
        parameters=row.get("schema") if isinstance(row.get("schema"), dict) else {"type": "object", "properties": {}, "additionalProperties": False},
        command_template=[str(item) for item in config.get("commandTemplate") or [] if str(item or "").strip()] or None,
        action_templates={
            str(key): [str(part) for part in value if str(part or "").strip()]
            for key, value in (config.get("actionTemplates") if isinstance(config.get("actionTemplates"), dict) else {}).items()
            if isinstance(value, list)
        },
        actions=actions,
        output_schema=config.get("outputSchema") if isinstance(config.get("outputSchema"), dict) else {},
        json_mode=bool(config.get("jsonMode")),
        risk_level=str(config.get("riskLevel") or "medium").strip() or "medium",
        timeout_seconds=int(config.get("timeoutSeconds") or _DEFAULT_TIMEOUT_SECONDS),
        resolved_command_path=str(config.get("resolvedCommandPath") or "").strip() or _resolve_executable(entry_command),
        metadata=metadata,
    )


def register_imported_cli_tools(registry: SkillRegistry, rows: list[dict[str, Any]]) -> list[str]:
    registered: list[str] = []
    for row in rows:
        spec = _spec_from_tool_row(row)
        if spec is None:
            continue
        tool_name = spec.tool_name
        if not tool_name or registry.get_tool(tool_name) is not None:
            continue
        registry.register_tool(
            ImportedCliTool(spec),
            metadata=SkillMetadata(
                source="cli",
                tags=["cli", spec.shape],
                additional={
                    "source_type": "cli",
                    "provider_id": spec.metadata.get("provider_id"),
                    "shape": spec.shape,
                    "entry_command": spec.entry_command,
                    "resolved_command_path": spec.resolved_command_path,
                    "actions": [
                        {
                            "command": item.command,
                            "description": item.description,
                            "parameters": item.parameters,
                            "command_template": item.command_template,
                            "json_mode": item.json_mode,
                            "output_schema": item.output_schema,
                        }
                        for item in spec.actions
                    ],
                    "imported_cli": True,
                },
            ),
        )
        registered.append(tool_name)
    return registered
