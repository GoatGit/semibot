"""Execution guardrails for installed skill scripts."""

from __future__ import annotations

import os
import re
import shlex
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

    def infer_flag_suffix_contracts(
        self,
        skill_root: Path,
        script_path: str,
    ) -> dict[str, tuple[str, ...]]:
        help_text = self._get_cached_help(skill_root, script_path)
        if not help_text:
            return {}
        return self._infer_flag_suffix_contracts_from_help(help_text)

    def check_argument_value_contracts(
        self,
        skill_root: Path,
        script_path: str,
        args: list[str],
    ) -> Advisory:
        contracts = self.infer_flag_suffix_contracts(skill_root, script_path)
        if not contracts:
            return Advisory(level="info", message="no inferable file-type contracts in --help")
        issues: list[str] = []
        for flag, value in self._extract_flag_assignments(args):
            expected_suffixes = contracts.get(flag)
            if not expected_suffixes:
                continue
            suffix = self._normalize_path_suffix(value)
            if not suffix:
                continue
            if suffix not in expected_suffixes:
                issues.append(
                    f"{script_path} expects {flag} to reference "
                    f"{'/'.join(expected_suffixes)} but got {value}"
                )
        if issues:
            return Advisory(level="error", message="; ".join(issues))
        return Advisory(level="ok", message="argument value types look consistent with --help")

    def _all_unknown_flags_are_aliases(self, unknown: set[str]) -> bool:
        return bool(unknown) and all(flag in self._alias_allowlist for flag in unknown)

    @staticmethod
    def _normalize_path_suffix(value: str) -> str:
        try:
            return Path(str(value).strip().strip("'\"")).suffix.lower()
        except Exception:
            return ""

    @staticmethod
    def _extract_flag_assignments(args: list[str]) -> list[tuple[str, str]]:
        assignments: list[tuple[str, str]] = []
        idx = 0
        while idx < len(args):
            token = str(args[idx]).strip()
            if token.startswith("--") and "=" in token:
                flag, value = token.split("=", 1)
                assignments.append((flag, value.strip()))
                idx += 1
                continue
            if re.fullmatch(r"--[a-zA-Z0-9][\w-]*|-\w", token) and idx + 1 < len(args):
                value = str(args[idx + 1]).strip()
                if value and not value.startswith("-"):
                    assignments.append((token, value))
                    idx += 2
                    continue
            idx += 1
        return assignments

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
        if suffix != ".py":
            return None
        return self._extract_python_argparse_help(full_path)

    @staticmethod
    def _extract_python_argparse_help(full_path: Path) -> str | None:
        try:
            content = full_path.read_text(encoding="utf-8", errors="replace")
        except Exception:
            return None
        flag_pattern = re.compile(r"['\"](?P<flag>--[a-zA-Z0-9][\w-]*|-\w)['\"]")
        flags: set[str] = set()
        required_flags: set[str] = set()

        for line in content.splitlines():
            if "add_argument(" not in line:
                continue
            found_flags = set(flag_pattern.findall(line))
            if not found_flags:
                continue
            flags.update(found_flags)
            if re.search(r"required\s*=\s*True", line):
                required_flags.update(flag for flag in found_flags if flag.startswith("--"))

        if not flags:
            return None

        script_name = full_path.name
        usage_tokens = sorted(required_flags)
        optional_token = "[options]" if flags else ""
        usage_parts = [script_name]
        if optional_token:
            usage_parts.append(optional_token)
        usage_parts.extend(usage_tokens)
        lines = [f"usage: {' '.join(part for part in usage_parts if part).strip()}", "", "options:"]
        for flag in sorted(flags):
            lines.append(f"  {flag}")
        return "\n".join(lines)

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

    def _infer_flag_suffix_contracts_from_help(self, help_text: str) -> dict[str, tuple[str, ...]]:
        contracts: dict[str, tuple[str, ...]] = {}
        flag_pattern = re.compile(r"(?<!\w)(--[a-zA-Z0-9][\w-]*|-\w)\b")
        keyword_map: list[tuple[tuple[str, ...], tuple[str, ...]]] = [
            (("markdown", "markdown file", "md file"), (".md", ".markdown")),
            (("html", "html file"), (".html", ".htm")),
            (("json", "json file"), (".json",)),
            (("pdf", "pdf file"), (".pdf",)),
            (("yaml", "yml"), (".yaml", ".yml")),
            (("csv", "csv file"), (".csv",)),
            (("excel", "xlsx", "spreadsheet"), (".xlsx", ".xls")),
            (("text", "text file", "txt"), (".txt", ".md", ".markdown")),
        ]

        for raw_line in help_text.splitlines():
            line = raw_line.strip()
            if not line or not line.startswith("-"):
                continue
            flags = flag_pattern.findall(line)
            if not flags:
                continue
            lowered = line.lower()
            inferred: list[str] = []
            for keywords, suffixes in keyword_map:
                if any(keyword in lowered for keyword in keywords):
                    for suffix in suffixes:
                        if suffix not in inferred:
                            inferred.append(suffix)
            if not inferred:
                continue
            suffix_tuple = tuple(inferred)
            for flag in flags:
                contracts[flag] = suffix_tuple
        return contracts

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
