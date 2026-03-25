from __future__ import annotations

import os
from pathlib import Path

import httpx
import pytest

from src.server.api import create_app


def _write_rules(path: Path) -> None:
    path.write_text("[]", encoding="utf-8")


def _write_fake_cli(path: Path) -> None:
    path.write_text(
        """#!/usr/bin/env python3
import json
import sys

args = sys.argv[1:]
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
if len(args) >= 3 and args[0] == "xhs" and args[1] == "search":
    print(json.dumps([{"query": args[2]}], ensure_ascii=False))
    sys.exit(0)
if len(args) >= 3 and args[0] == "xhs" and args[1] == "user":
    print(json.dumps([{"id": args[2]}], ensure_ascii=False))
    sys.exit(0)
print("unsupported", file=sys.stderr)
sys.exit(1)
""",
        encoding="utf-8",
    )
    os.chmod(path, 0o755)


@pytest.mark.asyncio
async def test_runtime_import_cli_registers_group_tool(tmp_path: Path) -> None:
    db_path = tmp_path / "events.db"
    rules_path = tmp_path / "rules.json"
    fake_cli = tmp_path / "fakecli"
    _write_rules(rules_path)
    _write_fake_cli(fake_cli)

    app = create_app(db_path=str(db_path), rules_path=str(rules_path))
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        response = await client.post(
            "/v1/tools/import-cli",
            json={
                "command": [str(fake_cli), "xhs"],
                "shape": "group",
                "source": "web",
                "toolName": "fake_xhs",
            },
        )
        assert response.status_code == 200
        payload = response.json()["data"]
        assert payload["status"] == "registered"

        catalog = await client.get("/v1/tools/catalog")
        items = catalog.json()["items"]
        tool_ids = {item["toolId"] for item in items}
        assert "cli:tmp:fake_xhs" not in tool_ids
        assert any(item["toolName"] == "fake_xhs" and item["sourceType"] == "cli" for item in items)


@pytest.mark.asyncio
async def test_runtime_import_cli_channel_auto_requires_approval(tmp_path: Path) -> None:
    db_path = tmp_path / "events.db"
    rules_path = tmp_path / "rules.json"
    fake_cli = tmp_path / "fakecli"
    _write_rules(rules_path)
    _write_fake_cli(fake_cli)

    app = create_app(db_path=str(db_path), rules_path=str(rules_path))
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        response = await client.post(
            "/v1/tools/import-cli",
            json={
                "command": [str(fake_cli), "xhs"],
                "shape": "group",
                "source": "channel_auto",
                "toolName": "fake_xhs_auto",
                "reason": "missing capability",
            },
        )
        assert response.status_code == 200
        request = response.json()["data"]
        assert request["status"] == "awaiting_approval"

        before = await client.get("/v1/tools/catalog")
        assert all(item["toolName"] != "fake_xhs_auto" for item in before.json()["items"])

        approve = await client.post(
            f"/v1/tools/import-cli/{request['id']}/decision",
            json={"approved": True},
        )
        assert approve.status_code == 200
        assert approve.json()["data"]["status"] == "registered"

        after = await client.get("/v1/tools/catalog")
        assert any(item["toolName"] == "fake_xhs_auto" for item in after.json()["items"])
