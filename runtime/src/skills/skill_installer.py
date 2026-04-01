"""Builtin tool to install skills from folder/zip, remote URL, or skills.sh registry."""

from __future__ import annotations

import os
import re
import shutil
import subprocess
import tempfile
import threading
import time
import webbrowser
import zipfile
from pathlib import Path
from typing import Any
from urllib.parse import urlparse
from urllib.request import urlopen

from src.bootstrap import default_skills_path
from src.constants.config import (
    GH_AUTH_LOGIN_TIMEOUT_SECONDS,
    REGISTRY_NAME_PATTERN,
    SKILLS_CLI_AUTO_CONFIRM_INTERVAL,
    SKILLS_CLI_TIMEOUT_SECONDS,
)
from src.skills._http_utils import validate_remote_url
from src.skills.index_manager import SkillsIndexManager, resolve_skill_dir, resolve_skill_md_dir
from src.skills.base import BaseTool, ToolResult
from src.skills.package_loader import register_installed_package_tools
from src.skills.registry import SkillRegistry
from src.utils.logging import get_logger

logger = get_logger(__name__)


def _safe_extract_zip(source: Path, destination: Path) -> None:
    destination_root = destination.resolve()
    with zipfile.ZipFile(source, "r") as zf:
        for member in zf.infolist():
            member_name = str(member.filename or "").strip()
            if not member_name:
                continue
            target = (destination_root / member_name).resolve()
            if target != destination_root and destination_root not in target.parents:
                raise ValueError(f"zip member escapes extraction root: {member_name}")
        zf.extractall(destination_root)


class SkillInstallerTool(BaseTool):
    def __init__(self, registry: SkillRegistry) -> None:
        self._registry = registry

    @property
    def name(self) -> str:
        return "skill_installer"

    @property
    def description(self) -> str:
        return (
            "Install a skill from local folder/zip, remote zip URL, or skills.sh registry "
            "into ~/.semibot/skills and refresh the local skill index."
        )

    @property
    def parameters(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "source_path": {"type": "string", "description": "Local folder path or .zip file path."},
                "source_url": {"type": "string", "description": "Optional remote .zip URL (http/https)."},
                "skill_name": {"type": "string", "description": "Optional target skill name. Defaults to source name."},
                "registry_name": {
                    "type": "string",
                    "description": (
                        "Skill name in skills.sh registry (e.g. 'vercel-labs/agent-browser@agent-browser'). "
                        "When provided, installs via `npx skills add`."
                    ),
                },
                "force": {"type": "boolean", "description": "Overwrite existing installed skill directory.", "default": False},
                "refresh_only": {"type": "boolean", "description": "Only refresh runtime index from installed skills.", "default": False},
            },
            "required": [],
            "additionalProperties": False,
        }

    async def execute(
        self,
        source_path: str | None = None,
        source_url: str | None = None,
        skill_name: str | None = None,
        registry_name: str | None = None,
        force: bool = False,
        refresh_only: bool = False,
        **_: Any,
    ) -> ToolResult:
        try:
            if registry_name and str(registry_name).strip():
                result = _install_from_registry(
                    registry=self._registry,
                    registry_name=str(registry_name).strip(),
                    skills_root=os.getenv("SEMIBOT_SKILLS_PATH", str(default_skills_path())),
                )
            else:
                result = install_or_refresh_skill(
                    registry=self._registry,
                    source_path=source_path,
                    source_url=source_url,
                    skill_name=skill_name,
                    force=force,
                    refresh_only=refresh_only,
                    skills_root=os.getenv("SEMIBOT_SKILLS_PATH", str(default_skills_path())),
                )
        except Exception as exc:
            return ToolResult.error_result(str(exc))
        return ToolResult.success_result(result)


def install_or_refresh_skill(
    *,
    registry: SkillRegistry,
    source_path: str | None = None,
    source_url: str | None = None,
    skill_name: str | None = None,
    force: bool = False,
    refresh_only: bool = False,
    skills_root: str | Path | None = None,
) -> dict[str, Any]:
    root = Path(skills_root or os.getenv("SEMIBOT_SKILLS_PATH", str(default_skills_path()))).expanduser()
    root.mkdir(parents=True, exist_ok=True)
    temp_dirs: list[tempfile.TemporaryDirectory[str]] = []
    index = SkillsIndexManager(root)

    if refresh_only:
        reindex_result = index.reindex(scope="incremental")
        summary = register_installed_package_tools(registry, skills_root=root)
        return {"ok": True, "action": "refresh", "reindex": reindex_result, **summary}

    raw = str(source_path or "").strip()
    remote = str(source_url or "").strip()
    if not raw and not remote:
        raise ValueError("source_path or source_url is required unless refresh_only=true")

    src: Path
    source_kind = "manual"
    if remote:
        parsed = urlparse(remote)
        if parsed.scheme != "https":
            raise ValueError("source_url must use https://")
        allowed, reason = validate_remote_url(remote, allow_localhost=False)
        if not allowed:
            raise ValueError(reason or "source_url is blocked")
        download_temp = tempfile.TemporaryDirectory(prefix="semibot_skill_install_")
        temp_dirs.append(download_temp)
        downloaded_zip = Path(download_temp.name) / "skill.zip"
        with urlopen(remote, timeout=30) as response:  # nosec B310 - controlled by runtime policy/tool config
            downloaded_zip.write_bytes(response.read())
        src = downloaded_zip
        source_kind = "url"
    else:
        src = Path(raw).expanduser()
        if not src.exists():
            raise FileNotFoundError(f"source_path not found: {src}")

    try:
        if src.is_file():
            if src.suffix.lower() != ".zip":
                raise ValueError("source_path file must be .zip")
            extracted_temp = tempfile.TemporaryDirectory(prefix="semibot_skill_extract_")
            temp_dirs.append(extracted_temp)
            extracted_root = Path(extracted_temp.name)
            _safe_extract_zip(src, extracted_root)
            skill_dir = resolve_skill_dir(extracted_root) or resolve_skill_md_dir(extracted_root)
            default_name = src.stem
            if source_kind == "manual":
                source_kind = "zip"
        else:
            skill_dir = resolve_skill_dir(src) or resolve_skill_md_dir(src)
            default_name = src.name
            if source_kind == "manual":
                source_kind = "local"

        if skill_dir is None:
            raise ValueError("invalid skill: missing SKILL.md and scripts/")

        target_name = str(skill_name or default_name).strip()
        if not target_name:
            raise ValueError("skill_name cannot be empty")

        target_dir = root / target_name
        if target_dir.exists():
            if not force:
                raise ValueError(f"target skill already exists: {target_name}; use force=true to overwrite")
            shutil.rmtree(target_dir)

        shutil.copytree(skill_dir, target_dir)
        index_record = index.upsert_after_install(target_name, source=source_kind)
        refresh = register_installed_package_tools(registry, skills_root=root)
        return {
            "ok": True,
            "action": "install",
            "source_path": str(src),
            "source_type": source_kind,
            "installed_path": str(target_dir),
            "skill_name": target_name,
            "index_updated": True,
            "index_record": index_record,
            "registered_in_runtime": False,
            "refresh": refresh,
        }
    finally:
        for item in temp_dirs:
            item.cleanup()


# ---------------------------------------------------------------------------
# Registry install helpers
# ---------------------------------------------------------------------------

def _safe_write(stdin: Any, data: bytes) -> None:
    """Write to stdin, ignoring errors if the process already exited."""
    try:
        stdin.write(data)
        stdin.flush()
    except Exception:
        pass


def _run_skills_cli(args: list[str], timeout: int = SKILLS_CLI_TIMEOUT_SECONDS) -> tuple[int, str, str]:
    """Run `npx skills <args>` under HOME with auto-confirm stdin."""
    env = {**os.environ, "NO_COLOR": "1", "FORCE_COLOR": "0", "TERM": "dumb"}
    proc = subprocess.Popen(
        ["npx", "skills", *args],
        cwd=os.path.expanduser("~"),
        env=env,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    # Auto-confirm interactive prompts (same sequence as TS: \n, a\n, \n)
    auto_inputs = [b"\n", b"a\n", b"\n"]
    for i, data in enumerate(auto_inputs):
        threading.Timer(
            SKILLS_CLI_AUTO_CONFIRM_INTERVAL * (i + 1),
            lambda d=data: _safe_write(proc.stdin, d),
        ).start()
    try:
        stdout_bytes, stderr_bytes = proc.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        proc.kill()
        stdout_bytes, stderr_bytes = proc.communicate()
        return 124, stdout_bytes.decode(errors="replace"), stderr_bytes.decode(errors="replace") + "\nskills cli timeout"
    return proc.returncode or 0, stdout_bytes.decode(errors="replace"), stderr_bytes.decode(errors="replace")


def _candidate_agents_skills_roots() -> list[str]:
    """Return candidate directories where `npx skills add` may have written skills."""
    home = os.path.expanduser("~")
    cwd = os.getcwd()
    roots = [
        os.path.join(home, ".agents", "skills"),
        os.path.join(cwd, "apps", "api", ".agents", "skills"),
        os.path.join(cwd, ".agents", "skills"),
        os.path.join(cwd, "runtime", ".agents", "skills"),
    ]
    return list(dict.fromkeys(roots))


def _scan_skill_dirs(root: str) -> dict[str, str]:
    """Scan a directory tree for skill dirs (containing SKILL.md). Returns {name: path}."""
    resolved = os.path.realpath(root)
    found: dict[str, str] = {}
    if not os.path.isdir(resolved):
        return found
    stack = [resolved]
    while stack:
        current = stack.pop()
        try:
            entries = os.listdir(current)
        except OSError:
            continue
        has_skill_md = any(
            os.path.isfile(os.path.join(current, e)) and e == "SKILL.md"
            for e in entries
        )
        if has_skill_md:
            name = os.path.basename(current)
            if name and name not in found:
                found[name] = current
            continue
        for entry in entries:
            full = os.path.join(current, entry)
            if os.path.isdir(full) and not entry.startswith("."):
                stack.append(full)
    return found


_ANSI_ESCAPE = re.compile(r"\x1b\[[0-9;]*m")


def _strip_ansi(text: str) -> str:
    """Remove ANSI escape sequences from text."""
    return _ANSI_ESCAPE.sub("", text)


def _search_registry(keyword: str) -> str | None:
    """Search skills.sh registry for a keyword and return the first matching full name (owner/repo@skill)."""
    code, stdout, stderr = _run_skills_cli(["search", keyword])
    if code != 0:
        logger.warn(
            "[SkillInstaller] skills search failed",
            extra={"keyword": keyword, "exit_code": code, "stderr": stderr.strip()[:200]},
        )
        return None

    # Strip ANSI color codes before matching (skills CLI ignores NO_COLOR)
    clean = _strip_ansi(stdout)
    # Match patterns like "owner/repo@skill" in the output, skip the banner placeholder
    for match in re.finditer(r"([a-zA-Z0-9._-]+/[a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+)", clean):
        name = match.group(1)
        if name != "owner/repo@skill":
            return name
    return None


_AUTH_FAILURE_PATTERN = re.compile(
    r"Authentication failed|could not read Username|terminal prompts disabled"
    r"|Permission denied|401|403 Forbidden|fatal: could not read",
    re.IGNORECASE,
)


def _is_auth_failure(stdout: str, stderr: str) -> bool:
    """Detect GitHub authentication failure from CLI output."""
    combined = f"{stdout}\n{stderr}"
    return bool(_AUTH_FAILURE_PATTERN.search(combined))


def _check_gh_auth() -> bool:
    """Return True if `gh auth status` reports a valid login."""
    try:
        result = subprocess.run(
            ["gh", "auth", "status"],
            capture_output=True,
            text=True,
            timeout=10,
        )
        return result.returncode == 0
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return False


def _extract_device_code(text: str) -> str | None:
    """Extract GitHub device code (e.g. 'ABCD-1234') from gh CLI output."""
    match = re.search(r"one-time code[:\s]*([A-Z0-9]{4}-[A-Z0-9]{4})", text, re.IGNORECASE)
    if not match:
        match = re.search(r"code[:\s]*([A-Z0-9]{4}-[A-Z0-9]{4})", text, re.IGNORECASE)
    return match.group(1) if match else None


def _try_gh_auth_web() -> dict[str, Any]:
    """Run `gh auth login --web`, open browser automatically, and wait for user to complete auth.

    Flow:
      1. Start `gh auth login --web` subprocess
      2. Read its early output to capture the one-time device code
      3. Open the browser via webbrowser.open() (subprocess may fail to do this)
      4. Send Enter to the subprocess so it proceeds to wait for auth
      5. Wait for the subprocess to finish (user completes auth in browser)

    Returns a dict with success, message, and optionally code/url.
    """
    verify_url = "https://github.com/login/device"

    try:
        proc = subprocess.Popen(
            ["gh", "auth", "login", "--web", "-p", "https", "--git-protocol", "https"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env={**os.environ, "NO_COLOR": "1", "FORCE_COLOR": "0", "BROWSER": ""},
        )
    except FileNotFoundError:
        return {
            "success": False,
            "message": "gh CLI 未安装，请先安装: https://cli.github.com/",
        }

    # Read early output to capture device code before sending Enter.
    # gh writes the code to stderr, then waits for Enter on stdin.
    collected = ""
    device_code: str | None = None
    deadline = time.monotonic() + 10  # 10s to capture the code
    while time.monotonic() < deadline:
        # Non-blocking read: check if process produced output
        if proc.stderr is not None:
            import select
            ready, _, _ = select.select([proc.stderr], [], [], 0.5)
            if ready:
                chunk = proc.stderr.read1(4096) if hasattr(proc.stderr, "read1") else os.read(proc.stderr.fileno(), 4096)  # type: ignore[union-attr]
                collected += chunk.decode(errors="replace")
                device_code = _extract_device_code(collected)
                if device_code:
                    break
        if proc.poll() is not None:
            break

    # Also check stdout
    if not device_code and proc.stdout is not None:
        try:
            import select
            ready, _, _ = select.select([proc.stdout], [], [], 0.5)
            if ready:
                chunk = os.read(proc.stdout.fileno(), 4096)
                stdout_text = chunk.decode(errors="replace")
                device_code = _extract_device_code(stdout_text)
                collected += stdout_text
        except Exception:
            pass

    if device_code:
        logger.info(
            "[SkillInstaller] Captured device code, opening browser",
            extra={"code": device_code, "url": verify_url},
        )
        # Open browser ourselves — subprocess may not be able to
        try:
            webbrowser.open(verify_url)
        except Exception:
            logger.warn("[SkillInstaller] Failed to open browser automatically")
    else:
        logger.warn(
            "[SkillInstaller] Could not capture device code from gh output",
            extra={"output": collected.strip()[:300]},
        )

    # Send Enter so gh proceeds to wait for browser auth completion
    _safe_write(proc.stdin, b"\n")

    # Now wait for the user to complete auth in the browser
    try:
        stdout_bytes, stderr_bytes = proc.communicate(timeout=GH_AUTH_LOGIN_TIMEOUT_SECONDS)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.communicate()
        if device_code:
            return {
                "success": False,
                "auth_required": True,
                "code": device_code,
                "url": verify_url,
                "message": (
                    f"认证等待超时。请在浏览器中打开 {verify_url} 并输入验证码: {device_code}\n"
                    "完成后重新安装技能。"
                ),
            }
        return {
            "success": False,
            "message": "GitHub 认证超时，请手动运行: gh auth login",
        }

    if proc.returncode == 0:
        logger.info("[SkillInstaller] gh auth login --web succeeded")
        return {"success": True, "message": "GitHub 认证成功！"}

    # Process exited non-zero — maybe user didn't complete auth
    if device_code:
        return {
            "success": False,
            "auth_required": True,
            "code": device_code,
            "url": verify_url,
            "message": (
                f"请在浏览器中打开 {verify_url} 并输入验证码: {device_code}\n"
                "完成认证后重新安装技能。"
            ),
        }

    full_output = collected + stderr_bytes.decode(errors="replace") + stdout_bytes.decode(errors="replace")
    return {
        "success": False,
        "message": f"GitHub 认证失败，请手动运行: gh auth login\n{full_output.strip()[:300]}",
    }


def _install_from_registry(
    *,
    registry: SkillRegistry,
    registry_name: str,
    skills_root: str | Path | None = None,
) -> dict[str, Any]:
    """Install a skill from skills.sh registry via `npx skills add`."""
    # Validate name
    if not re.match(REGISTRY_NAME_PATTERN, registry_name):
        raise ValueError(
            f"Invalid registry_name '{registry_name}': "
            "must match [a-zA-Z0-9._/@-]+"
        )

    # Short name auto-resolve: if no "/" or "@", search registry first
    if "/" not in registry_name and "@" not in registry_name:
        resolved = _search_registry(registry_name)
        if resolved:
            logger.info(
                "[SkillInstaller] Resolved short name to full registry name",
                extra={"short_name": registry_name, "resolved": resolved},
            )
            registry_name = resolved
        else:
            raise ValueError(
                f"No skill matching '{registry_name}' found in skills.sh registry"
            )

    root = Path(skills_root or os.getenv("SEMIBOT_SKILLS_PATH", str(default_skills_path()))).expanduser()
    root.mkdir(parents=True, exist_ok=True)

    # Run npx skills add <name> --yes
    args = ["add", registry_name, "--yes"]
    code, stdout, stderr = _run_skills_cli(args)

    # Retry without --yes if the flag is not recognized
    unknown_opt = re.compile(r"unknown option|unknown argument|invalid option", re.IGNORECASE)
    if code != 0 and unknown_opt.search(f"{stdout}\n{stderr}"):
        logger.warn(
            "[SkillInstaller] --yes flag not recognized, retrying without it",
            extra={"registry_name": registry_name},
        )
        args_no_yes = ["add", registry_name]
        code, stdout, stderr = _run_skills_cli(args_no_yes)

    if code != 0:
        # Detect GitHub auth failure and attempt browser-based login
        if _is_auth_failure(stdout, stderr):
            logger.warn(
                "[SkillInstaller] GitHub authentication failure detected, attempting gh auth login --web",
                extra={"registry_name": registry_name},
            )
            auth_result = _try_gh_auth_web()
            if auth_result.get("success"):
                # Auth succeeded, retry the install
                logger.info("[SkillInstaller] Retrying install after successful auth")
                code, stdout, stderr = _run_skills_cli(args)
            else:
                raise RuntimeError(
                    f"GitHub 认证失败，无法安装技能 '{registry_name}'。\n"
                    f"{auth_result['message']}"
                )

    if code != 0:
        raise RuntimeError(
            f"npx skills add failed (exit {code}): {(stderr or stdout).strip()}"
        )

    logger.info(
        "[SkillInstaller] npx skills add succeeded",
        extra={"registry_name": registry_name, "stdout_len": len(stdout)},
    )

    # Scan candidate dirs for newly installed skills and sync to semibot skills root
    synced: list[str] = []
    for candidate_root in _candidate_agents_skills_roots():
        skill_dirs = _scan_skill_dirs(candidate_root)
        for name, src_path in skill_dirs.items():
            dst = root / name
            if dst.exists():
                shutil.rmtree(dst)
            shutil.copytree(src_path, dst)
            synced.append(name)

    if not synced:
        logger.warn(
            "[SkillInstaller] No skills found after npx skills add",
            extra={"registry_name": registry_name, "candidates": _candidate_agents_skills_roots()},
        )

    # Update index and refresh runtime
    index = SkillsIndexManager(root)
    index_records = []
    for skill_name in synced:
        record = index.upsert_after_install(skill_name, source="registry")
        index_records.append(record)

    refresh = register_installed_package_tools(registry, skills_root=root)

    return {
        "ok": True,
        "action": "registry_install",
        "registry_name": registry_name,
        "synced_skills": synced,
        "installed_path": str(root),
        "source_type": "registry",
        "index_records": index_records,
        "refresh": refresh,
        "cli_stdout": stdout.strip()[:500],
    }
