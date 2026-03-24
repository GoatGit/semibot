#!/usr/bin/env python3
"""Live E2E smoke test for the Semibot CLI provider with opencli/xiaohongshu.

This script verifies three layers:
1. opencli can be installed locally via npm
2. the xiaohongshu command family is discoverable
3. Semibot can install a temp CLI-manifest package and execute it

If the opencli browser bridge is missing, the script reports a blocked status
instead of treating it as a tool-chain failure.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

from src.skills.registry import SkillRegistry
from src.skills.skill_installer import install_or_refresh_skill


def _run(cmd: list[str], *, cwd: Path | None = None, check: bool = True) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        cmd,
        cwd=str(cwd) if cwd else None,
        check=check,
        capture_output=True,
        text=True,
    )


def _write_temp_skill(package_dir: Path, opencli_bin: Path) -> None:
    (package_dir / "cli-tools").mkdir(parents=True, exist_ok=True)
    (package_dir / "SKILL.md").write_text(
        (
            "---\n"
            "name: opencli-xiaohongshu-e2e\n"
            "summary: Temporary live E2E package for Semibot CLI provider\n"
            "---\n\n"
            "Temporary package used by runtime/scripts/opencli_xiaohongshu_e2e.py.\n"
        ),
        encoding="utf-8",
    )
    manifest = {
        "tool_name": "xiaohongshu_search",
        "description": "Search Xiaohongshu notes via opencli",
        "tool_id": "cli:opencli-xiaohongshu-e2e:xiaohongshu_search",
        "provider_id": "opencli-xiaohongshu-e2e",
        "command": [
            str(opencli_bin),
            "xiaohongshu",
            "search",
            "{query}",
            "--limit",
            "{limit}",
            "--format",
            "json",
        ],
        "json_mode": True,
        "timeout_seconds": 30,
        "stderr_policy": "log_only",
        "nonzero_exit_policy": "error",
        "output_schema": {"type": "array"},
        "parameters": {
            "type": "object",
            "properties": {
                "query": {"type": "string"},
                "limit": {"type": "integer", "default": 5},
            },
            "required": ["query"],
            "additionalProperties": False,
        },
    }
    (package_dir / "cli-tools" / "xiaohongshu_search.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


async def _run_provider_e2e(package_dir: Path, skills_root: Path, *, query: str, limit: int) -> dict[str, object]:
    registry = SkillRegistry()
    install_result = install_or_refresh_skill(
        registry=registry,
        source_path=str(package_dir),
        skill_name="opencli-xiaohongshu-e2e",
        force=True,
        skills_root=skills_root,
    )
    result = await registry.execute("xiaohongshu_search", {"query": query, "limit": limit})
    return {
        "install": {
            "skill_name": install_result["skill_name"],
            "installed_path": install_result["installed_path"],
            "registered": install_result["refresh"]["registered"],
            "cli_manifest_count": install_result["refresh"]["cli_manifest_count"],
        },
        "execute": {
            "success": result.success,
            "error": result.error,
            "metadata": result.metadata,
            "result": result.result,
        },
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Live E2E smoke test for opencli/xiaohongshu via Semibot CLI provider")
    parser.add_argument("--query", default="杭州咖啡", help="Xiaohongshu search query")
    parser.add_argument("--limit", type=int, default=3, help="Result limit")
    args = parser.parse_args()

    if shutil.which("npm") is None:
        print(json.dumps({"ok": False, "stage": "preflight", "error": "npm is required"}, ensure_ascii=False))
        return 2

    with tempfile.TemporaryDirectory(prefix="opencli-e2e-") as npm_root, tempfile.TemporaryDirectory(
        prefix="opencli-skill-"
    ) as package_root, tempfile.TemporaryDirectory(prefix="semibot-skills-") as skills_root:
        npm_root_path = Path(npm_root)
        package_dir = Path(package_root)
        skills_root_path = Path(skills_root)

        _run(["npm", "install", "--prefix", str(npm_root_path), "@jackwener/opencli"])
        opencli_bin = npm_root_path / "node_modules" / ".bin" / "opencli"

        version = _run([str(opencli_bin), "--version"]).stdout.strip()
        xhs_help = _run([str(opencli_bin), "xiaohongshu", "--help"]).stdout
        search_help = _run([str(opencli_bin), "xiaohongshu", "search", "--help"]).stdout
        doctor = _run([str(opencli_bin), "doctor"], check=False)

        _write_temp_skill(package_dir, opencli_bin)
        provider_result = asyncio.run(
            _run_provider_e2e(package_dir, skills_root_path, query=args.query, limit=args.limit)
        )

        payload = {
            "ok": True,
            "opencli_version": version,
            "doctor_exit_code": doctor.returncode,
            "doctor_stdout": doctor.stdout.strip(),
            "doctor_stderr": doctor.stderr.strip(),
            "xiaohongshu_help_detected": "xiaohongshu commands" in xhs_help,
            "search_supports_json": "--format" in search_help and "json" in search_help,
            "provider_result": provider_result,
        }

        exec_meta = provider_result["execute"]["metadata"]
        stderr = str(exec_meta.get("stderr") or "")
        if "Browser Extension is not connected" in stderr:
            payload["blocked_reason"] = "opencli browser bridge extension is not connected"

        print(json.dumps(payload, ensure_ascii=False, indent=2))
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
