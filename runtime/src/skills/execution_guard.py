"""Execution guardrails for installed skill scripts."""

from __future__ import annotations

import os
import re
import shlex
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Literal


@dataclass
class ValidationResult:
    blocked: bool
    reason: str = ""
    suggestion: str | None = None


@dataclass
class Advisory:
    level: Literal["ok", "info", "warning", "error"]
    message: str
    help_text_snippet: str | None = None


class ExecutionGuard:
    def validate_skill_exists(self, skills_root: Path, skill_name: str) -> ValidationResult:
        skill_dir = (skills_root / skill_name).resolve()
        if skill_dir != skills_root and skills_root not in skill_dir.parents:
            return ValidationResult(blocked=True, reason="invalid_skill_name")
        if not skill_dir.exists() or not skill_dir.is_dir():
            return ValidationResult(blocked=True, reason="skill_not_found")
        return ValidationResult(blocked=False)

    def validate_script_path(self, skill_root: Path, script_ref: str) -> ValidationResult:
        resolved = (skill_root / script_ref).resolve()
        scripts_root = (skill_root / "scripts").resolve()
        if scripts_root not in resolved.parents and resolved != scripts_root:
            return ValidationResult(blocked=True, reason="path_traversal")
        if not resolved.exists():
            return ValidationResult(blocked=True, reason="script_not_found")
        if not resolved.is_file():
            return ValidationResult(blocked=True, reason="script_not_file")
        return ValidationResult(blocked=False)


class ExecutionAdvisor:
    def __init__(self) -> None:
        self._help_cache: dict[tuple[str, str, float], str | None] = {}
        aliases = os.getenv("SEMIBOT_SKILL_FLAG_ALIAS_ALLOWLIST", "").strip()
        self._alias_allowlist = {
            item.strip()
            for item in aliases.split(",")
            if item.strip()
        }

    def check_script_help(self, skill_root: Path, script_path: str, args: list[str]) -> Advisory:
        help_text = self._get_cached_help(skill_root, script_path)
        if not help_text:
            return Advisory(level="info", message="script --help unavailable, proceeding as-is")

        format_recognized, expected_flags, required_flags = self._parse_help_output(help_text)
        if not format_recognized:
            return Advisory(
                level="info",
                message="--help output format not recognized, proceeding as-is",
                help_text_snippet=help_text[:500],
            )

        provided_flags = self._extract_flags(args)
        unknown = provided_flags - expected_flags
        missing_required = required_flags - provided_flags

        issues: list[str] = []
        level: Literal["ok", "warning", "error"] = "ok"
        if missing_required:
            issues.append(f"missing required flags: {', '.join(sorted(missing_required))}")
            level = "error"
        if unknown:
            issues.append(f"unrecognized flags: {', '.join(sorted(unknown))}")
            if self._all_unknown_flags_are_aliases(unknown):
                if level != "error":
                    level = "warning"
            else:
                level = "error"

        if issues:
            return Advisory(level=level, message="; ".join(issues), help_text_snippet=help_text[:500])
        return Advisory(level="ok", message="args look consistent with --help")

    def describe_script_interfaces(
        self,
        skill_root: Path,
        script_paths: list[str],
        *,
        max_scripts: int = 8,
    ) -> list[str]:
        descriptions: list[str] = []
        for script_path in script_paths[:max_scripts]:
            help_text = self._get_cached_help(skill_root, script_path)
            if not help_text:
                continue
            usage_line = ""
            for line in help_text.splitlines():
                stripped = line.strip()
                if stripped.lower().startswith("usage:"):
                    usage_line = stripped
                    break
            if not usage_line:
                continue
            descriptions.append(f"{script_path}: {usage_line}")
        return descriptions

    def _all_unknown_flags_are_aliases(self, unknown: set[str]) -> bool:
        return bool(unknown) and all(flag in self._alias_allowlist for flag in unknown)

    def _get_cached_help(self, skill_root: Path, script_path: str) -> str | None:
        full_path = skill_root / script_path
        try:
            mtime = full_path.stat().st_mtime
        except OSError:
            return None
        cache_key = (str(skill_root), script_path, mtime)
        if cache_key in self._help_cache:
            return self._help_cache[cache_key]
        result = self._run_help(full_path)
        self._help_cache[cache_key] = result
        return result

    def _run_help(self, full_path: Path) -> str | None:
        suffix = full_path.suffix.lower()
        if suffix == ".py":
            cmd = [sys.executable, str(full_path), "--help"]
        elif suffix in {".sh", ".bash"}:
            cmd = ["bash", str(full_path), "--help"]
        elif suffix in {".js", ".mjs", ".cjs"}:
            cmd = ["node", str(full_path), "--help"]
        else:
            cmd = [str(full_path), "--help"]
        try:
            completed = subprocess.run(
                cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=2,
                cwd=str(full_path.parent.parent),
            )
        except Exception:
            return None
        output = (completed.stdout or "").strip()
        return output or None

    def _parse_help_output(self, help_text: str) -> tuple[bool, set[str], set[str]]:
        text = help_text or ""
        lower = text.lower()
        if "usage:" not in lower and "options:" not in lower and "optional arguments:" not in lower:
            return False, set(), set()

        flag_pattern = re.compile(r"(?<!\w)(--[a-zA-Z0-9][\w-]*|-\w)\b")
        expected_flags = set(flag_pattern.findall(text))
        if not expected_flags:
            return False, set(), set()

        usage_line = ""
        for line in text.splitlines():
            if line.strip().lower().startswith("usage:"):
                usage_line = line.strip()
                break
        required_flags = self._extract_required_flags_from_usage(usage_line)
        return True, expected_flags, required_flags

    @staticmethod
    def _extract_required_flags_from_usage(usage_line: str) -> set[str]:
        if not usage_line:
            return set()
        required: set[str] = set()
        depth = 0
        current = []
        tokens = usage_line.split()
        for token in tokens[1:]:
            depth += token.count("[")
            normalized = token.strip("[]")
            if normalized.startswith("-") and depth == 0:
                current.append(normalized)
            depth -= token.count("]")
        for token in current:
            if token.startswith("--") or re.fullmatch(r"-\w", token):
                required.add(token)
        return required

    @staticmethod
    def _extract_flags(args: list[str]) -> set[str]:
        flags: set[str] = set()
        for token in args:
            value = str(token).strip()
            if value.startswith("--"):
                flags.add(value.split("=", 1)[0])
            elif re.fullmatch(r"-\w", value):
                flags.add(value)
        return flags

    @staticmethod
    def split_command_args(command: str) -> tuple[str, list[str]]:
        parts = shlex.split(command, posix=True)
        if not parts:
            return "", []
        script_idx = -1
        for idx, token in enumerate(parts):
            normalized = token.strip().strip("'\"").replace("\\", "/")
            if normalized.startswith("scripts/"):
                script_idx = idx
                break
        if script_idx < 0:
            return "", []
        return parts[script_idx], parts[script_idx + 1 :]
