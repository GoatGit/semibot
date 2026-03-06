"""Builtin tool to execute script commands declared inside installed skills."""

from __future__ import annotations

import asyncio
import difflib
import os
import shutil
import re
import shlex
from pathlib import Path
from typing import Any

from src.bootstrap import default_skills_path
from src.skills.base import BaseTool, ToolResult
from src.skills.execution_guard import ExecutionAdvisor, ExecutionGuard


class SkillScriptRunnerTool(BaseTool):
    """Run bash commands for scripts under ~/.semibot/skills/<skill>/scripts safely."""

    def __init__(self) -> None:
        self.skills_root = Path(
            os.getenv("SEMIBOT_SKILLS_PATH", str(default_skills_path()))
        ).expanduser().resolve()
        self.default_timeout = int(os.getenv("SEMIBOT_SKILL_SCRIPT_TIMEOUT", "180"))
        self.max_output_chars = int(os.getenv("SEMIBOT_SKILL_SCRIPT_MAX_OUTPUT_CHARS", "20000"))
        self.guard = ExecutionGuard()
        self.advisor = ExecutionAdvisor()
        self._artifact_claim_pattern = re.compile(
            r"(?i)(saved to|written to|output(?: file)?|generated(?: file)?|created(?: file)?)\s*:\s*(/[^\\\s'\"`]+\.[a-z0-9]+)"
        )
        self._artifact_future_markers = (
            "will ",
            "would ",
            "should ",
            "to be ",
            "expected ",
            "planned ",
        )

    @property
    def name(self) -> str:
        return "skill_script_runner"

    @property
    def description(self) -> str:
        return (
            "Execute a bash command for an installed skill. "
            "Command must target files under skill/scripts/. "
            "Use after reading SKILL.md and following its command guidance."
        )

    @property
    def parameters(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "skill_name": {
                    "type": "string",
                    "description": "Installed skill id, e.g. deep-research",
                },
                "command": {
                    "type": "string",
                    "description": "Bash command like: node scripts/research.js --topic test",
                },
                "timeout": {
                    "type": "integer",
                    "description": "Timeout in seconds",
                    "default": 180,
                },
            },
            "required": ["skill_name", "command"],
        }

    def _resolve_skill_root(self, skill_name: str) -> Path:
        skill = skill_name.strip()
        if not skill:
            raise ValueError("skill_name is required")
        validation = self.guard.validate_skill_exists(self.skills_root, skill)
        if validation.blocked:
            raise ValueError(validation.reason or f"skill not found: {skill}")
        skill_root = (self.skills_root / skill).resolve()
        return skill_root

    @staticmethod
    def _looks_like_script_filename(token: str) -> bool:
        candidate = token.strip().strip("'\"")
        if "/" in candidate or "\\" in candidate:
            return False
        return bool(re.search(r"\.(py|js|mjs|cjs|sh|bash|ts)$", candidate, flags=re.IGNORECASE))

    @staticmethod
    def _basename(path: str) -> str:
        return path.replace("\\", "/").split("/")[-1]

    def _guess_existing_script(self, missing_rel: str, available_scripts: list[str]) -> str | None:
        if not available_scripts:
            return None
        normalized_missing = missing_rel.replace("\\", "/")
        missing_name = self._basename(normalized_missing)
        available_names = {self._basename(item): item for item in available_scripts}
        if missing_name in available_names:
            return available_names[missing_name]
        close = difflib.get_close_matches(missing_name, list(available_names.keys()), n=1, cutoff=0.72)
        if close:
            return available_names.get(close[0])
        return None

    def _validate_command(self, command: str, skill_root: Path) -> tuple[str, list[str]]:
        if not command.strip():
            raise ValueError("command is required")
        # Ensure command references at least one scripts/* path inside the skill.
        parts = shlex.split(command, posix=True)
        if not parts:
            raise ValueError("invalid command")

        found_script_ref = False
        rewrites: list[str] = []
        available_scripts: list[str] = sorted(
            str(p.relative_to(skill_root)).replace("\\", "/")
            for p in (skill_root / "scripts").glob("*")
            if p.is_file()
        ) if (skill_root / "scripts").exists() else []
        normalized_parts: list[str] = []
        for token in parts:
            normalized = token.strip().strip("'\"").replace("\\", "/")
            if "scripts/" not in normalized:
                if self._looks_like_script_filename(normalized):
                    guessed = f"scripts/{normalized}"
                    guessed_path = (skill_root / guessed).resolve()
                    if guessed_path.exists():
                        found_script_ref = True
                        rewrites.append(f"{normalized} -> {guessed}")
                        normalized_parts.append(guessed)
                        continue
                normalized_parts.append(token)
                continue
            idx = normalized.find("scripts/")
            rel = normalized[idx:]
            if rel.startswith("/") or rel.startswith("~"):
                normalized_parts.append(token)
                continue
            if any(seg == ".." for seg in rel.split("/")):
                raise ValueError("script path escapes skill root")
            candidate = (skill_root / rel).resolve()
            if candidate != skill_root and skill_root not in candidate.parents:
                raise ValueError("script path escapes skill root")
            validation = self.guard.validate_script_path(skill_root, rel)
            if validation.blocked and validation.reason != "script_not_found":
                raise ValueError(validation.reason)
            if not candidate.exists():
                guessed_rel = self._guess_existing_script(rel, available_scripts)
                if guessed_rel:
                    rewrites.append(f"{rel} -> {guessed_rel}")
                    normalized_parts.append(token.replace(rel, guessed_rel))
                    found_script_ref = True
                    continue
                hint = ", ".join(available_scripts[:12]) if available_scripts else "none"
                raise ValueError(f"script target not found: {rel}. available scripts: {hint}")
            found_script_ref = True
            normalized_parts.append(token)
        if not found_script_ref:
            hint = ", ".join(available_scripts[:12]) if available_scripts else "none"
            raise ValueError(
                "command must reference at least one file under scripts/. "
                f"available scripts: {hint}"
            )
        return self._normalize_command_interpreter(normalized_parts), rewrites

    @staticmethod
    def _normalize_command_interpreter(parts: list[str]) -> str:
        if not parts:
            return ""
        normalized = list(parts)
        has_python = shutil.which("python") is not None
        if not has_python:
            fallback = shutil.which("python3") or shutil.which("python3.11") or shutil.which("python3.10")
            if fallback:
                fallback_name = Path(fallback).name
                normalized = [fallback_name if token == "python" else token for token in normalized]
        return shlex.join(normalized)

    @staticmethod
    def _build_shell_command(command: str) -> str:
        prologue = (
            "if ! command -v python >/dev/null 2>&1; then "
            "if command -v python3 >/dev/null 2>&1; then "
            "python(){ command python3 \"$@\"; }; "
            "elif command -v python3.11 >/dev/null 2>&1; then "
            "python(){ command python3.11 \"$@\"; }; "
            "elif command -v python3.10 >/dev/null 2>&1; then "
            "python(){ command python3.10 \"$@\"; }; "
            "fi; "
            "fi; "
        )
        return prologue + command

    def _trim(self, text: bytes) -> tuple[str, bool]:
        decoded = text.decode("utf-8", errors="replace")
        if len(decoded) <= self.max_output_chars:
            return decoded, False
        return decoded[: self.max_output_chars], True

    def _extract_claimed_artifacts(self, *texts: str) -> list[str]:
        claimed: list[str] = []
        for text in texts:
            for line in str(text or "").splitlines():
                lowered = line.strip().lower()
                if not lowered:
                    continue
                if any(marker in lowered for marker in self._artifact_future_markers):
                    continue
                for _label, path in self._artifact_claim_pattern.findall(line):
                    normalized = str(path or "").strip()
                    if normalized and normalized not in claimed:
                        claimed.append(normalized)
        return claimed

    async def execute(
        self,
        skill_name: str,
        command: str,
        timeout: int | None = None,
        **_: Any,
    ) -> ToolResult:
        try:
            skill_root = self._resolve_skill_root(skill_name)
            safe_command, rewrites = self._validate_command(command, skill_root)
        except Exception as exc:
            return ToolResult.error_result(str(exc))
        script_path, script_args = self.advisor.split_command_args(safe_command)
        if script_path:
            advisory = self.advisor.check_script_help(skill_root, script_path, script_args)
            if advisory.level == "error":
                return ToolResult.error_result(
                    advisory.message,
                    advisory={
                        "level": advisory.level,
                        "message": advisory.message,
                    },
                    script_help=advisory.help_text_snippet,
                    command=command,
                    resolved_command=safe_command,
                )
        else:
            advisory = None

        final_timeout = timeout if isinstance(timeout, int) and timeout > 0 else self.default_timeout

        try:
            shell_command = self._build_shell_command(safe_command)
            proc = await asyncio.create_subprocess_exec(
                "bash",
                "-lc",
                shell_command,
                cwd=str(skill_root),
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            try:
                stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=final_timeout)
            except asyncio.TimeoutError:
                proc.kill()
                await proc.wait()
                return ToolResult.error_result(f"command timed out after {final_timeout}s")

            trimmed_stdout, stdout_truncated = self._trim(stdout or b"")
            trimmed_stderr, stderr_truncated = self._trim(stderr or b"")
            payload = {
                "skill_name": skill_name,
                "command": command,
                "resolved_command": safe_command,
                "command_rewrites": rewrites,
                "exit_code": int(proc.returncode or 0),
                "stdout": trimmed_stdout,
                "stderr": trimmed_stderr,
                "stdout_truncated": stdout_truncated,
                "stderr_truncated": stderr_truncated,
            }
            if advisory and advisory.level in {"warning", "info"}:
                payload["advisory"] = advisory.message
                if advisory.help_text_snippet:
                    payload["script_help"] = advisory.help_text_snippet
            claimed_artifacts = self._extract_claimed_artifacts(trimmed_stdout, trimmed_stderr)
            if claimed_artifacts:
                payload["claimed_artifacts"] = claimed_artifacts
                missing_artifacts = [
                    artifact
                    for artifact in claimed_artifacts
                    if not Path(artifact).expanduser().exists()
                ]
                if missing_artifacts:
                    payload["missing_claimed_artifacts"] = missing_artifacts
                    advisory_payload = {
                        "level": "error",
                        "message": (
                            "script claimed artifact(s) that do not exist: "
                            + ", ".join(missing_artifacts)
                        ),
                    }
                    return ToolResult.error_result(
                        advisory_payload["message"],
                        advisory=advisory_payload,
                        payload=payload,
                    )
            if proc.returncode != 0:
                message = trimmed_stderr.strip() or f"command failed with exit code {proc.returncode}"
                return ToolResult.error_result(message, **payload)
            return ToolResult.success_result(payload)
        except Exception as exc:
            return ToolResult.error_result(f"command execution failed: {exc}")
