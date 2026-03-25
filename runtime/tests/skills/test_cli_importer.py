from __future__ import annotations

import json
import os
from pathlib import Path

import pytest

from src.skills.cli_importer import ImportedCliTool, extract_cli_spec


def _write_fake_cli(path: Path) -> None:
    path.write_text(
        """#!/usr/bin/env python3
import json
import sys

args = sys.argv[1:]
if args == ["echo", "--help"]:
    print("Usage: fakecli echo <name> [--json]")
    sys.exit(0)
if args == ["xhs", "--help"]:
    print("Usage: fakecli xhs [options] [command]")
    print("")
    print("Commands:")
    print("  search [options] <query>  Search notes")
    print("  user [options] <id>       Fetch user notes")
    print("  help [command]            display help for command")
    sys.exit(0)
if args == ["xhs", "search", "--help"]:
    print("Usage: fakecli xhs search <query> [--json]")
    sys.exit(0)
if args == ["xhs", "user", "--help"]:
    print("Usage: fakecli xhs user <id> [--json]")
    sys.exit(0)
if len(args) >= 2 and args[0] == "echo":
    name = args[1]
    if "--json" in args[2:]:
        print(json.dumps({"value": name}, ensure_ascii=False))
    else:
        print(name)
    sys.exit(0)
if len(args) >= 3 and args[0] == "xhs" and args[1] == "search":
    query = args[2]
    payload = [{"query": query, "kind": "search"}]
    print(json.dumps(payload, ensure_ascii=False))
    sys.exit(0)
if len(args) >= 3 and args[0] == "xhs" and args[1] == "user":
    user_id = args[2]
    payload = [{"id": user_id, "kind": "user"}]
    print(json.dumps(payload, ensure_ascii=False))
    sys.exit(0)
print("unsupported", file=sys.stderr)
sys.exit(1)
""",
        encoding="utf-8",
    )
    os.chmod(path, 0o755)


@pytest.mark.asyncio
async def test_extract_direct_cli_spec_and_execute(tmp_path: Path) -> None:
    fake_cli = tmp_path / "fakecli"
    _write_fake_cli(fake_cli)

    spec = await extract_cli_spec(
        command=[str(fake_cli), "echo"],
        shape="direct",
        tool_name="fake_echo",
    )

    assert spec.shape == "direct"
    assert spec.parameters["required"] == ["name"]
    tool = ImportedCliTool(spec)
    result = await tool.execute(name="alice")
    assert result.success is True
    assert result.result == {"value": "alice"}


@pytest.mark.asyncio
async def test_extract_group_cli_spec_and_execute(tmp_path: Path) -> None:
    fake_cli = tmp_path / "fakecli"
    _write_fake_cli(fake_cli)

    spec = await extract_cli_spec(
        command=[str(fake_cli), "xhs"],
        shape="group",
        tool_name="fake_xhs",
    )

    assert spec.shape == "group"
    commands = {item.command for item in spec.actions}
    assert commands == {"search", "user"}
    tool = ImportedCliTool(spec)
    result = await tool.execute(command="search", query="杭州咖啡")
    assert result.success is True
    assert result.result == [{"query": "杭州咖啡", "kind": "search"}]
