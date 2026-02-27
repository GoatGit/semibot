"""Semibot V2 CLI entrypoint.

This CLI is the first step of the V2.0 refactor and intentionally keeps
commands small while the new single-process architecture is built out.
"""

from __future__ import annotations

import argparse
import asyncio
import copy
import json
import os
import re
import select
import signal
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import tomllib
import termios
import tty
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any, Callable
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import Request, urlopen

import uvicorn

from src.bootstrap import (
    default_config_path as bootstrap_default_config_path,
)
from src.bootstrap import (
    default_db_path as bootstrap_default_db_path,
)
from src.bootstrap import (
    default_rules_path as bootstrap_default_rules_path,
)
from src.bootstrap import (
    default_skills_path as bootstrap_default_skills_path,
)
from src.bootstrap import (
    ensure_runtime_home,
)
from src.bootstrap import (
    semibot_home,
)
from src.events.event_engine import EventEngine
from src.events.event_store import EventStore
from src.events.models import Event, utc_now
from src.events.rule_loader import load_rules, rules_to_json, set_rule_active
from src.events.rule_evaluator import RuleEvaluator
from src.server.api import create_app
from src.skills.bootstrap import create_default_registry
from src.utils.logging import setup_logging

CLI_VERSION = "2.0.0"
EXIT_SUCCESS = 0
EXIT_ARGS_ERROR = 2
EXIT_CONFIG_ERROR = 3
EXIT_NOT_FOUND = 4
EXIT_APPROVAL_BLOCKED = 5
EXIT_EXTERNAL_ERROR = 6
EXIT_TIMEOUT = 7
EXIT_INTERNAL_ERROR = 8
OUTPUT_FORMAT = "json"
COLOR_ENABLED = True
_BANNER_INNER_WIDTH = 61
_BANNER_TEXT_WIDTH = _BANNER_INNER_WIDTH - 2
_ANSI_ESCAPE_RE = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]|\x1b[@-_]")


def _print_json(payload: dict[str, Any]) -> None:
    if OUTPUT_FORMAT == "ndjson":
        print(json.dumps(payload, ensure_ascii=False))
        return
    if OUTPUT_FORMAT == "yaml":
        try:
            import yaml  # type: ignore

            print(yaml.safe_dump(payload, allow_unicode=True, sort_keys=False).rstrip())
            return
        except Exception:
            print(json.dumps(payload, ensure_ascii=False, indent=2))
            return
    if OUTPUT_FORMAT == "table":
        _print_table_payload(payload)
        return
    print(json.dumps(payload, ensure_ascii=False, indent=2))


def _print_table_payload(payload: dict[str, Any]) -> None:
    def emit_value(key: str, value: Any, indent: int = 0) -> None:
        prefix = "  " * indent
        if isinstance(value, dict):
            print(f"{prefix}{key}:")
            for child_key, child_value in value.items():
                emit_value(str(child_key), child_value, indent + 1)
            return
        if isinstance(value, list):
            print(f"{prefix}{key}:")
            if not value:
                print(f"{prefix}  - (empty)")
                return
            for idx, item in enumerate(value, start=1):
                if isinstance(item, dict):
                    print(f"{prefix}  - [{idx}]")
                    for child_key, child_value in item.items():
                        emit_value(str(child_key), child_value, indent + 2)
                else:
                    rendered = item if isinstance(item, str) else json.dumps(item, ensure_ascii=False)
                    print(f"{prefix}  - {rendered}")
            return
        rendered = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False)
        print(f"{prefix}{key}: {rendered}")

    for top_key, top_value in payload.items():
        emit_value(str(top_key), top_value, 0)


def _clr(text: str, code: str) -> str:
    if not COLOR_ENABLED:
        return text
    return f"\x1b[{code}m{text}\x1b[0m"


def _banner_border_line() -> str:
    return _clr("+" + ("-" * _BANNER_INNER_WIDTH) + "+", "38;5;240")


def _banner_content_line(text: str, color: str, *, center: bool = True) -> str:
    clipped = text[:_BANNER_TEXT_WIDTH]
    rendered = clipped.center(_BANNER_TEXT_WIDTH) if center else clipped.ljust(_BANNER_TEXT_WIDTH)
    return _clr(f"| {rendered} |", color)


def _banner_lines(title: str | None = None) -> list[str]:
    logo_lines = [
        " ____  _____ __  __ ___ ____   ___ _____",
        "/ ___|| ____|  \\/  |_ _| __ )/  _  \\_  _|",
        "\\___ \\|  _| | |\\/| || ||  _ \\| | | || |",
        " ___) | |___| |  | || || |_) | |_| || |",
        "|____/|_____|_|  |_|___|____/\\ ___ /|_|",
    ]
    logo_width = max(len(line) for line in logo_lines)
    left_pad = max(0, (_BANNER_TEXT_WIDTH - logo_width) // 2)

    lines = [_banner_border_line()]
    for index, line in enumerate(logo_lines):
        color = "38;5;166;1" if index < 2 else "38;5;215"
        block_line = (" " * left_pad + line).ljust(_BANNER_TEXT_WIDTH)
        lines.append(_banner_content_line(block_line, color, center=False))
    if title:
        lines.append(_banner_content_line("", "38;5;240"))
        lines.append(_banner_content_line(title, "38;5;208;1"))
    lines.append(_banner_border_line())
    return lines


def _print_banner() -> None:
    if not sys.stdout.isatty():
        return
    for line in _banner_lines():
        print(line)


def _clear_screen() -> None:
    if not sys.stdout.isatty():
        return
    sys.stdout.write("\x1b[2J\x1b[H")
    sys.stdout.flush()


def _sanitize_terminal_text(text: str) -> str:
    # Strip terminal control sequences and non-printable chars to avoid "dirty" output.
    cleaned = _ANSI_ESCAPE_RE.sub("", text)
    return "".join(ch for ch in cleaned if ch in {"\n", "\t"} or ord(ch) >= 32)


def _run_with_wait_indicator(enabled: bool, operation: Callable[[], Any]) -> Any:
    if not enabled:
        return operation()

    stop_event = threading.Event()
    frames = [".  ", ".. ", "..."]
    line_prefix = "Semibot> thinking"
    rendered_len = len(line_prefix) + 3

    def _worker() -> None:
        index = 0
        while not stop_event.is_set():
            frame = frames[index % len(frames)]
            sys.stdout.write(f"\r{line_prefix}{frame}")
            sys.stdout.flush()
            index += 1
            stop_event.wait(0.35)
        sys.stdout.write("\r" + (" " * rendered_len) + "\r")
        sys.stdout.flush()

    worker = threading.Thread(target=_worker, daemon=True)
    worker.start()
    try:
        return operation()
    finally:
        stop_event.set()
        worker.join(timeout=1.0)


def _print_chat_session_intro(*, session_id: str, runtime_url: str) -> None:
    print(_clr("Semibot Chat Session", "1;38;5;45"))
    print(f"  Version    : {CLI_VERSION}")
    print(f"  Session ID : {session_id}")
    print(f"  Runtime    : {runtime_url}")
    print("  Status     : Chat session started. Type 'exit' to quit.")
    print("")


def _read_key() -> str:
    def _read_next(timeout: float) -> str | None:
        ready, _, _ = select.select([sys.stdin], [], [], timeout)
        if not ready:
            return None
        return sys.stdin.read(1)

    def _read_escape_sequence() -> str:
        # Collect full CSI/SS3 sequence, e.g. "[A", "[1;2A", "OA"
        chars: list[str] = []
        for _ in range(8):
            nxt = _read_next(0.08)
            if nxt is None:
                break
            chars.append(nxt)
            if nxt.isalpha() or nxt == "~":
                break
        return "".join(chars)

    fd = sys.stdin.fileno()
    old_settings = termios.tcgetattr(fd)
    try:
        tty.setraw(fd)
        ch = sys.stdin.read(1)
        if ch == "\x1b":
            seq = _read_escape_sequence()
            if seq in {"[A", "OA"} or seq.endswith("A"):
                return "up"
            if seq in {"[B", "OB"} or seq.endswith("B"):
                return "down"
            return "esc"
        if ch in {"k", "K"}:
            return "up"
        if ch in {"j", "J"}:
            return "down"
        if ch == " ":
            return "space"
        if ch in {"\r", "\n"}:
            return "enter"
        if ch == "\x03":
            raise KeyboardInterrupt
        return ch
    finally:
        termios.tcsetattr(fd, termios.TCSADRAIN, old_settings)


def _single_select(
    *,
    title: str,
    options: list[str],
    header_lines: list[str] | None = None,
    initial_index: int = 0,
) -> int:
    if not options:
        return 0
    index = max(0, min(initial_index, len(options) - 1))
    while True:
        _clear_screen()
        if header_lines:
            for line in header_lines:
                print(line)
            print("")
        print(_clr(title, "38;5;208;1"))
        print(_clr("Use ↑/↓ (or j/k), Enter to confirm", "2"))
        print("")
        for i, option in enumerate(options):
            focused = i == index
            prefix = _clr("❯", "38;5;45;1") if focused else " "
            text = _clr(option, "38;5;15;1") if focused else _clr(option, "38;5;250")
            print(f" {prefix} {text}")
        key = _read_key()
        if key == "up":
            index = (index - 1) % len(options)
        elif key == "down":
            index = (index + 1) % len(options)
        elif key == "enter":
            return index


def _multi_select(
    *,
    title: str,
    options: list[str],
    defaults: list[str] | None = None,
    header_lines: list[str] | None = None,
) -> list[str]:
    if not options:
        return []
    selected = set(defaults or [])
    index = 0
    while True:
        _clear_screen()
        if header_lines:
            for line in header_lines:
                print(line)
            print("")
        print(_clr(title, "38;5;208;1"))
        print(_clr("Use ↑/↓ (or j/k), Space to toggle, Enter to continue", "2"))
        print("")
        for i, option in enumerate(options):
            focused = i == index
            checked = option in selected
            mark = _clr("●", "38;5;76;1") if checked else _clr("○", "38;5;240")
            prefix = _clr("❯", "38;5;45;1") if focused else " "
            text = _clr(option, "38;5;15;1") if focused else _clr(option, "38;5;250")
            print(f" {prefix} {mark} {text}")
        key = _read_key()
        if key == "up":
            index = (index - 1) % len(options)
        elif key == "down":
            index = (index + 1) % len(options)
        elif key == "space":
            option = options[index]
            if option in selected:
                selected.remove(option)
            else:
                selected.add(option)
        elif key == "enter":
            ordered = [item for item in options if item in selected]
            return ordered


def _default_db_path() -> str:
    return str(bootstrap_default_db_path())


def _default_config_path() -> str:
    env_path = os.getenv("SEMIBOT_CONFIG")
    if env_path:
        return str(Path(env_path).expanduser())
    return str(bootstrap_default_config_path())


def _default_rules_path() -> str:
    return str(bootstrap_default_rules_path())


def _default_skills_path() -> str:
    return str(bootstrap_default_skills_path())


def _default_mcp_path() -> str:
    return str((semibot_home() / "mcp.json").expanduser())


def _default_api_port() -> int:
    try:
        return int(str(os.getenv("API_PORT", "3001")).strip())
    except ValueError:
        return 3001


def _default_web_port() -> int:
    try:
        return int(str(os.getenv("WEB_PORT", "3000")).strip())
    except ValueError:
        return 3000


def _default_log_level() -> str:
    value = str(os.getenv("SEMIBOT_LOG_LEVEL", "CRITICAL")).upper()
    valid = {"DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"}
    return value if value in valid else "CRITICAL"


def _bootstrap_from_args(args: argparse.Namespace) -> None:
    db_path = getattr(args, "db_path", None)
    rules_path = getattr(args, "rules_path", None)
    ensure_runtime_home(db_path=db_path, rules_path=rules_path)


def _parse_json_arg(raw: str, *, field_name: str) -> tuple[Any | None, str | None]:
    try:
        return json.loads(raw), None
    except json.JSONDecodeError as exc:
        return None, f"invalid {field_name} json: {exc}"


def _error_payload(*, resource: str, action: str, code: str, message: str) -> dict[str, Any]:
    return {
        "version": CLI_VERSION,
        "resource": resource,
        "action": action,
        "ok": False,
        "error": {
            "code": code,
            "message": message,
        },
    }


def _load_config(path: str) -> tuple[dict[str, Any] | None, str | None]:
    config_path = Path(path).expanduser()
    if not config_path.exists():
        return None, f"config not found: {config_path}"
    try:
        with config_path.open("rb") as file:
            parsed = tomllib.load(file)
    except tomllib.TOMLDecodeError as exc:
        return None, f"invalid toml: {exc}"
    if not isinstance(parsed, dict):
        return None, "config root must be a table"
    return parsed, None


def _toml_escape(value: str) -> str:
    return value.replace("\\", "\\\\").replace('"', '\\"')


def _to_toml_value(value: Any) -> str:
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        return str(value)
    if isinstance(value, list):
        return "[" + ", ".join(_to_toml_value(item) for item in value) + "]"
    if value is None:
        return '""'
    return f'"{_toml_escape(str(value))}"'


def _dump_toml(data: dict[str, Any]) -> str:
    lines: list[str] = []

    def emit_table(prefix: str, table: dict[str, Any]) -> None:
        scalar_items = {
            key: value
            for key, value in table.items()
            if not isinstance(value, dict)
        }
        nested_items = {
            key: value
            for key, value in table.items()
            if isinstance(value, dict)
        }

        if prefix:
            lines.append(f"[{prefix}]")
        for key in sorted(scalar_items.keys()):
            lines.append(f"{key} = {_to_toml_value(scalar_items[key])}")
        if prefix:
            lines.append("")

        for key in sorted(nested_items.keys()):
            child_prefix = f"{prefix}.{key}" if prefix else key
            emit_table(child_prefix, nested_items[key])

    emit_table("", data)
    content = "\n".join(lines).rstrip() + "\n"
    return content


def _write_config(path: str, data: dict[str, Any]) -> None:
    config_path = Path(path).expanduser()
    config_path.parent.mkdir(parents=True, exist_ok=True)
    content = _dump_toml(data)
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", delete=False, dir=config_path.parent) as tmp:
        tmp.write(content)
        temp_path = Path(tmp.name)
    temp_path.replace(config_path)


def _split_path(path: str) -> list[str]:
    return [part.strip() for part in path.split(".") if part.strip()]


def _config_get(data: dict[str, Any], key_path: str) -> tuple[Any | None, bool]:
    current: Any = data
    for part in _split_path(key_path):
        if not isinstance(current, dict) or part not in current:
            return None, False
        current = current[part]
    return current, True


def _config_set(data: dict[str, Any], key_path: str, value: Any) -> None:
    parts = _split_path(key_path)
    if not parts:
        raise ValueError("key path is empty")
    current = data
    for part in parts[:-1]:
        next_obj = current.get(part)
        if not isinstance(next_obj, dict):
            next_obj = {}
            current[part] = next_obj
        current = next_obj
    current[parts[-1]] = value


def _config_unset(data: dict[str, Any], key_path: str) -> bool:
    parts = _split_path(key_path)
    if not parts:
        return False
    current: Any = data
    for part in parts[:-1]:
        if not isinstance(current, dict) or part not in current:
            return False
        current = current[part]
    if not isinstance(current, dict) or parts[-1] not in current:
        return False
    del current[parts[-1]]
    return True


def _parse_config_value(raw: str, value_type: str) -> tuple[Any | None, str | None]:
    if value_type == "string":
        return raw, None
    if value_type == "int":
        try:
            return int(raw), None
        except ValueError:
            return None, f"invalid int value: {raw}"
    if value_type == "float":
        try:
            return float(raw), None
        except ValueError:
            return None, f"invalid float value: {raw}"
    if value_type == "bool":
        lowered = raw.strip().lower()
        if lowered in {"true", "1", "yes", "y", "on"}:
            return True, None
        if lowered in {"false", "0", "no", "n", "off"}:
            return False, None
        return None, f"invalid bool value: {raw}"
    if value_type == "json":
        return _parse_json_arg(raw, field_name="value")
    parsed_json, error = _parse_json_arg(raw, field_name="value")
    if error is None:
        return parsed_json, None
    return raw, None


def _flatten_dict(data: dict[str, Any], prefix: str = "") -> dict[str, Any]:
    flat: dict[str, Any] = {}
    for key, value in data.items():
        path = f"{prefix}.{key}" if prefix else str(key)
        if isinstance(value, dict):
            flat.update(_flatten_dict(value, path))
        else:
            flat[path] = value
    return flat


def _sorted_section_keys(config: dict[str, Any]) -> list[str]:
    base = [str(key) for key, value in config.items() if isinstance(value, dict)]
    priority = ["runtime", "llm"]
    ordered: list[str] = [item for item in priority if item in base]
    ordered.extend([item for item in sorted(base) if item not in ordered])
    return ordered


def _prompt_text(prompt: str, default: str | None = None) -> str:
    suffix = f" [{default}]" if default is not None else ""
    raw = input(f"{prompt}{suffix}: ").strip()
    if not raw and default is not None:
        return default
    return raw


def _prompt_yes_no(prompt: str, *, default: bool = False) -> bool:
    hint = "Y/n" if default else "y/N"
    while True:
        raw = input(f"{prompt} [{hint}]: ").strip().lower()
        if not raw:
            return default
        if raw in {"y", "yes"}:
            return True
        if raw in {"n", "no"}:
            return False
        print("Please answer with y or n.")


def _format_preview_value(value: Any) -> str:
    if isinstance(value, str):
        return value
    return json.dumps(value, ensure_ascii=False)


def _prompt_pick_sections(section_keys: list[str], default_sections: list[str]) -> list[str]:
    if not section_keys:
        return []
    print("\nSelect sections to configure:")
    for index, key in enumerate(section_keys, start=1):
        marker = "*" if key in default_sections else " "
        print(f"  {index}. [{marker}] {key}")
    print("  a. [ ] all sections")
    raw = input("Choose sections (comma-separated indices, Enter for defaults): ").strip().lower()
    if not raw:
        return list(default_sections)
    if raw in {"a", "all"}:
        return list(section_keys)

    selected: list[str] = []
    for token in raw.split(","):
        token = token.strip()
        if not token:
            continue
        if not token.isdigit():
            continue
        idx = int(token)
        if 1 <= idx <= len(section_keys):
            selected.append(section_keys[idx - 1])

    deduped: list[str] = []
    for item in selected:
        if item not in deduped:
            deduped.append(item)
    return deduped or list(default_sections)


def _edit_section(config: dict[str, Any], section: str) -> list[str]:
    current = config.get(section)
    if not isinstance(current, dict):
        current = {}
        config[section] = current

    changed: list[str] = []
    scalar_keys = [k for k, v in current.items() if not isinstance(v, dict)]
    key_options = sorted(scalar_keys)
    selected_keys: list[str] = []
    if key_options:
        selected_keys = _multi_select(
            title=f"Select keys to configure in [{section}]",
            options=key_options,
            defaults=[],
            header_lines=[
                _clr("Semibot configure", "1;38;5;208"),
                _clr(f"Section: [{section}]", "1;38;5;208"),
            ],
        )
    else:
        print(_clr(f"No existing scalar keys under [{section}].", "2"))

    for key in selected_keys:
        old_value = current.get(key)
        raw = _prompt_text(
            f"{section}.{key}",
            default=_format_preview_value(old_value),
        )
        if raw == _format_preview_value(old_value):
            continue
        value, parse_error = _parse_config_value(raw, "auto")
        if parse_error:
            print(f"  skip invalid value: {parse_error}")
            continue
        current[key] = value
        changed.append(f"{section}.{key}")

    if _prompt_yes_no(f"Add new key under [{section}]?", default=False):
        while True:
            key = _prompt_text("new key name (empty to stop)", default="")
            if not key:
                break
            value_raw = _prompt_text(f"{section}.{key} value", default="")
            value, parse_error = _parse_config_value(value_raw, "auto")
            if parse_error:
                print(f"  skip invalid value: {parse_error}")
                continue
            current[key] = value
            changed.append(f"{section}.{key}")
    return changed


def _interactive_configure(args: argparse.Namespace, config: dict[str, Any]) -> tuple[dict[str, Any], bool]:
    config_path = str(Path(args.config_path).expanduser())
    summary_lines: list[str] = []
    for section in _sorted_section_keys(config):
        section_data = config.get(section)
        if not isinstance(section_data, dict):
            continue
        preview = ", ".join(sorted(section_data.keys())[:4])
        if len(section_data.keys()) > 4:
            preview = f"{preview}, ..."
        summary_lines.append(f"{section}: {preview or '(empty)'}")

    header_lines = [
        *_banner_lines("SEMIBOT CONFIGURE"),
        "",
        _clr(f"Config path: {config_path}", "2"),
        "",
        _clr("Existing config detected", "1;38;5;208"),
        _clr("┌────────────────────────────────────────────┐", "38;5;240"),
    ]
    for line in summary_lines[:6]:
        header_lines.append(_clr(f"│ {line[:42].ljust(42)} │", "38;5;246"))
    if not summary_lines:
        header_lines.append(_clr("│ (empty)                                    │", "38;5;246"))
    header_lines.append(_clr("└────────────────────────────────────────────┘", "38;5;240"))

    mode_idx = _single_select(
        title="Select configure mode",
        options=["Quick (recommended)", "Advanced"],
        header_lines=header_lines,
    )
    mode = "quick" if mode_idx == 0 else "advanced"
    section_keys = _sorted_section_keys(config)
    defaults = [item for item in ["runtime", "llm"] if item in section_keys]
    if not defaults and section_keys:
        defaults = [section_keys[0]]

    if args.section:
        selected_sections = [args.section] if args.section in section_keys else defaults
    elif mode == "advanced":
        selected_sections = _multi_select(
            title="Select sections to configure",
            options=section_keys,
            defaults=defaults,
            header_lines=header_lines,
        )
        if not selected_sections:
            selected_sections = defaults
    else:
        selected_sections = defaults

    working = copy.deepcopy(config)
    for section in selected_sections:
        _clear_screen()
        print(_clr("Semibot configure", "1;38;5;208"))
        print(_clr(f"Editing section: [{section}]", "1;38;5;208"))
        print(_clr("Press Enter to keep value unchanged", "2"))
        print("")
        _edit_section(working, section)

    if _prompt_yes_no("Edit custom dotted key?", default=False):
        while True:
            key_path = _prompt_text("dotted key (empty to stop)", default="")
            if not key_path:
                break
            existing, found = _config_get(working, key_path)
            default = _format_preview_value(existing) if found else ""
            value_raw = _prompt_text(key_path, default=default)
            value, parse_error = _parse_config_value(value_raw, "auto")
            if parse_error:
                print(f"  skip invalid value: {parse_error}")
                continue
            _config_set(working, key_path, value)

    old_flat = _flatten_dict(config)
    new_flat = _flatten_dict(working)
    diff_keys = sorted(set(old_flat.keys()) | set(new_flat.keys()))
    changes: list[dict[str, Any]] = []
    for key in diff_keys:
        old = old_flat.get(key)
        new = new_flat.get(key)
        if old != new:
            changes.append({"key": key, "old": old, "new": new})

    if not changes:
        return config, False

    print("\nPlanned changes:")
    for item in changes:
        print(f"  - {item['key']}: {_format_preview_value(item['old'])} -> {_format_preview_value(item['new'])}")

    if not _prompt_yes_no("Save changes?", default=False):
        return config, False

    return working, True


def cmd_init(args: argparse.Namespace) -> int:
    summary = ensure_runtime_home(db_path=args.db_path, rules_path=args.rules_path)
    _print_json(
        {
            "version": CLI_VERSION,
            "mode": "init",
            **summary,
        }
    )
    return EXIT_SUCCESS


def cmd_version(_args: argparse.Namespace) -> int:
    _print_json(
        {
            "version": CLI_VERSION,
            "mode": "version",
            "python": os.sys.version.split(" ", maxsplit=1)[0],
        }
    )
    return EXIT_SUCCESS


def cmd_doctor(args: argparse.Namespace) -> int:
    db_path = Path(args.db_path).expanduser()
    rules_path = Path(args.rules_path).expanduser()
    skills_path = Path(args.skills_path).expanduser()

    checks = {
        "db_path_exists": db_path.exists(),
        "rules_path_exists": rules_path.exists(),
        "skills_path_exists": skills_path.exists(),
    }

    recommended_env = {
        "OPENAI_API_KEY": bool(os.getenv("OPENAI_API_KEY")),
        "ANTHROPIC_API_KEY": bool(os.getenv("ANTHROPIC_API_KEY")),
        "TAVILY_API_KEY": bool(os.getenv("TAVILY_API_KEY")),
        "SERPAPI_API_KEY": bool(os.getenv("SERPAPI_API_KEY")),
    }

    ok = all(checks.values())
    _print_json(
        {
            "version": CLI_VERSION,
            "mode": "doctor",
            "ok": ok,
            "paths": {
                "db_path": str(db_path),
                "rules_path": str(rules_path),
                "skills_path": str(skills_path),
            },
            "checks": checks,
            "recommended_env": recommended_env,
            "hint": None if ok else "Run `semibot init` to bootstrap local runtime home.",
        }
    )
    return EXIT_SUCCESS if ok else EXIT_CONFIG_ERROR


def cmd_configure_show(args: argparse.Namespace) -> int:
    data, error = _load_config(args.config_path)
    if error:
        _print_json(
            _error_payload(
                resource="configure",
                action="show",
                code="CONFIG_NOT_FOUND",
                message=error,
            )
        )
        return EXIT_CONFIG_ERROR
    _print_json(
        {
            "version": CLI_VERSION,
            "resource": "configure",
            "action": "show",
            "config_path": str(Path(args.config_path).expanduser()),
            "data": data,
        }
    )
    return EXIT_SUCCESS


def cmd_configure(args: argparse.Namespace) -> int:
    data, error = _load_config(args.config_path)
    if error:
        _print_json(
            _error_payload(
                resource="configure",
                action="show",
                code="CONFIG_NOT_FOUND",
                message=error,
            )
        )
        return EXIT_CONFIG_ERROR

    config = data if data is not None else {}
    interactive = (
        not args.non_interactive
        and not getattr(args, "json", False)
        and sys.stdin.isatty()
        and sys.stdout.isatty()
    )
    if not interactive:
        return cmd_configure_show(args)

    try:
        updated, should_save = _interactive_configure(args, config)
    except KeyboardInterrupt:
        print("")
        _print_json(
            {
                "version": CLI_VERSION,
                "resource": "configure",
                "action": "interactive",
                "config_path": str(Path(args.config_path).expanduser()),
                "ok": False,
                "cancelled": True,
            }
        )
        return EXIT_SUCCESS

    if should_save:
        _write_config(args.config_path, updated)
        _print_json(
            {
                "version": CLI_VERSION,
                "resource": "configure",
                "action": "interactive",
                "config_path": str(Path(args.config_path).expanduser()),
                "ok": True,
                "saved": True,
            }
        )
    else:
        _print_json(
            {
                "version": CLI_VERSION,
                "resource": "configure",
                "action": "interactive",
                "config_path": str(Path(args.config_path).expanduser()),
                "ok": True,
                "saved": False,
            }
        )
    return EXIT_SUCCESS


def cmd_configure_get(args: argparse.Namespace) -> int:
    data, error = _load_config(args.config_path)
    if error:
        _print_json(
            _error_payload(
                resource="configure",
                action="get",
                code="CONFIG_NOT_FOUND",
                message=error,
            )
        )
        return EXIT_CONFIG_ERROR
    config = data if data is not None else {}
    value, found = _config_get(config, args.key)
    if not found:
        _print_json(
            _error_payload(
                resource="configure",
                action="get",
                code="CONFIG_KEY_NOT_FOUND",
                message=f"config key not found: {args.key}",
            )
        )
        return EXIT_NOT_FOUND
    _print_json(
        {
            "version": CLI_VERSION,
            "resource": "configure",
            "action": "get",
            "config_path": str(Path(args.config_path).expanduser()),
            "key": args.key,
            "value": value,
        }
    )
    return EXIT_SUCCESS


def cmd_configure_set(args: argparse.Namespace) -> int:
    data, error = _load_config(args.config_path)
    if error:
        _print_json(
            _error_payload(
                resource="configure",
                action="set",
                code="CONFIG_NOT_FOUND",
                message=error,
            )
        )
        return EXIT_CONFIG_ERROR
    config = data if data is not None else {}
    value, parse_error = _parse_config_value(args.value, args.value_type)
    if parse_error:
        _print_json(
            _error_payload(
                resource="configure",
                action="set",
                code="CONFIG_VALUE_INVALID",
                message=parse_error,
            )
        )
        return EXIT_ARGS_ERROR
    _config_set(config, args.key, value)
    _write_config(args.config_path, config)
    _print_json(
        {
            "version": CLI_VERSION,
            "resource": "configure",
            "action": "set",
            "config_path": str(Path(args.config_path).expanduser()),
            "key": args.key,
            "value": value,
            "ok": True,
        }
    )
    return EXIT_SUCCESS


def cmd_configure_unset(args: argparse.Namespace) -> int:
    data, error = _load_config(args.config_path)
    if error:
        _print_json(
            _error_payload(
                resource="configure",
                action="unset",
                code="CONFIG_NOT_FOUND",
                message=error,
            )
        )
        return EXIT_CONFIG_ERROR
    config = data if data is not None else {}
    removed = _config_unset(config, args.key)
    if not removed:
        _print_json(
            _error_payload(
                resource="configure",
                action="unset",
                code="CONFIG_KEY_NOT_FOUND",
                message=f"config key not found: {args.key}",
            )
        )
        return EXIT_NOT_FOUND
    _write_config(args.config_path, config)
    _print_json(
        {
            "version": CLI_VERSION,
            "resource": "configure",
            "action": "unset",
            "config_path": str(Path(args.config_path).expanduser()),
            "key": args.key,
            "ok": True,
        }
    )
    return EXIT_SUCCESS


def _runtime_base_url(args: argparse.Namespace) -> str:
    raw = str(getattr(args, "server_url", "") or "").strip()
    if not raw:
        raw = str(os.getenv("SEMIBOT_RUNTIME_URL", "http://127.0.0.1:8765")).strip()
    return raw.rstrip("/")


def _http_json_request(
    *,
    method: str,
    url: str,
    payload: dict[str, Any] | None = None,
    timeout: float = 5.0,
) -> dict[str, Any]:
    body: bytes | None = None
    headers: dict[str, str] = {"Accept": "application/json"}
    if payload is not None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        headers["Content-Type"] = "application/json"

    request = Request(url=url, data=body, method=method.upper(), headers=headers)
    try:
        with urlopen(request, timeout=timeout) as response:
            raw = response.read().decode("utf-8", errors="replace")
    except HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace") if exc.fp else str(exc)
        raise RuntimeError(f"HTTP {exc.code} {url}: {detail}") from exc
    except URLError as exc:
        raise RuntimeError(f"request failed for {url}: {exc.reason}") from exc

    if not raw:
        return {}
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"invalid JSON from {url}: {exc}") from exc
    if not isinstance(parsed, dict):
        raise RuntimeError(f"unexpected response from {url}: expected object JSON")
    return parsed


def _is_runtime_healthy(base_url: str) -> bool:
    health_url = f"{base_url}/healthz"
    try:
        payload = _http_json_request(method="GET", url=health_url, timeout=1.0)
    except Exception:
        return False
    return bool(payload.get("ok") is True)


def _require_runtime_server(base_url: str) -> str | None:
    if _is_runtime_healthy(base_url):
        return None
    return (
        f"runtime server unavailable at {base_url}. "
        "please start it first with `semibot serve start`."
    )


def _chat_start_via_runtime(
    args: argparse.Namespace,
    *,
    message: str,
    session_id: str | None,
    base_url: str,
) -> dict[str, Any]:
    url = f"{base_url}/api/v1/chat/start"
    payload = {
        "message": message,
        "agent_id": getattr(args, "agent_id", "semibot"),
        "session_id": session_id,
        "model": getattr(args, "model", None),
        "system_prompt": getattr(args, "system_prompt", None),
        "stream": False,
    }
    return _http_json_request(method="POST", url=url, payload=payload, timeout=300.0)


def _chat_in_session_via_runtime(
    args: argparse.Namespace,
    *,
    message: str,
    session_id: str,
    base_url: str,
) -> dict[str, Any]:
    url = f"{base_url}/api/v1/chat/sessions/{session_id}"
    payload = {
        "message": message,
        "agent_id": getattr(args, "agent_id", "semibot"),
        "model": getattr(args, "model", None),
        "system_prompt": getattr(args, "system_prompt", None),
        "stream": False,
    }
    return _http_json_request(method="POST", url=url, payload=payload, timeout=300.0)


def _runtime_list_approvals(base_url: str, *, status: str | None = "pending", limit: int = 20) -> dict[str, Any]:
    query_parts = [f"limit={max(1, min(limit, 200))}"]
    if status:
        query_parts.append(f"status={status}")
    query = "&".join(query_parts)
    return _http_json_request(method="GET", url=f"{base_url}/v1/approvals?{query}", timeout=10.0)


def _runtime_resolve_approval(base_url: str, approval_id: str, decision: str) -> dict[str, Any]:
    action = "approve" if decision == "approve" else "reject"
    return _http_json_request(
        method="POST",
        url=f"{base_url}/v1/approvals/{approval_id}/{action}",
        payload={},
        timeout=10.0,
    )


def _extract_pending_approval_ids(result: dict[str, Any]) -> list[str]:
    runtime_events = result.get("runtime_events")
    if not isinstance(runtime_events, list):
        return []
    ids: list[str] = []
    for item in runtime_events:
        if not isinstance(item, dict):
            continue
        if str(item.get("event") or "") != "approval.requested":
            continue
        data = item.get("data")
        if not isinstance(data, dict):
            continue
        approval_id = data.get("approval_id")
        if isinstance(approval_id, str) and approval_id:
            ids.append(approval_id)
    return ids


def _is_http_not_found_error(error: Exception) -> bool:
    text = str(error).lower()
    return "http 404" in text or "not found" in text


def _chat_send_first_turn_via_runtime(
    args: argparse.Namespace,
    *,
    message: str,
    session_id: str,
    base_url: str,
) -> dict[str, Any]:
    # If user specified --session-id, treat it as "resume existing session" first.
    if getattr(args, "session_id", None):
        try:
            return _chat_in_session_via_runtime(
                args,
                message=message,
                session_id=session_id,
                base_url=base_url,
            )
        except Exception as exc:
            if not _is_http_not_found_error(exc):
                raise
    return _chat_start_via_runtime(
        args,
        message=message,
        session_id=session_id,
        base_url=base_url,
    )


def cmd_chat(args: argparse.Namespace) -> int:
    resolved_session_id = args.session_id or f"chat_{int(datetime.now(UTC).timestamp() * 1000)}"
    runtime_url = _runtime_base_url(args)

    ready_error = _require_runtime_server(runtime_url)
    if ready_error:
        _print_json(
            _error_payload(
                resource="chat",
                action="connect",
                code="RUNTIME_UNAVAILABLE",
                message=ready_error,
            )
        )
        return EXIT_EXTERNAL_ERROR

    if sys.stdout.isatty() and not args.json:
        _print_banner()
        print("")

    if args.json:
        _print_json(
            {
                "version": CLI_VERSION,
                "mode": "chat",
                "session_id": resolved_session_id,
                "runtime_url": runtime_url,
                "message": "Chat session started. Type 'exit' to quit.",
            }
        )
    else:
        _print_chat_session_intro(session_id=resolved_session_id, runtime_url=runtime_url)

    def _handle_approval_command(raw: str) -> bool:
        text = raw.strip()
        if not text.startswith("/"):
            return False
        if text.lower() == "/approvals":
            try:
                payload = _runtime_list_approvals(runtime_url, status="pending", limit=20)
                items = payload.get("items")
                if not isinstance(items, list) or not items:
                    print("Semibot> 当前没有待审批项。")
                    return True
                print(f"Semibot> 待审批 {len(items)} 项：")
                for row in items:
                    if not isinstance(row, dict):
                        continue
                    print(
                        f"- {row.get('approval_id', 'unknown')} "
                        f"(risk={row.get('risk_level', 'unknown')}, status={row.get('status', 'unknown')})"
                    )
            except Exception as exc:
                print(f"Semibot> 读取审批列表失败: {exc}")
            return True

        approve_match = re.match(r"^/approve\s+([A-Za-z0-9_-]+)$", text, flags=re.IGNORECASE)
        if approve_match:
            approval_id = approve_match.group(1)
            try:
                payload = _runtime_resolve_approval(runtime_url, approval_id, "approve")
                print(f"Semibot> 已通过审批 {payload.get('approval_id', approval_id)} ({payload.get('status', 'approved')})")
            except Exception as exc:
                print(f"Semibot> 审批失败: {exc}")
            return True

        reject_match = re.match(r"^/reject\s+([A-Za-z0-9_-]+)$", text, flags=re.IGNORECASE)
        if reject_match:
            approval_id = reject_match.group(1)
            try:
                payload = _runtime_resolve_approval(runtime_url, approval_id, "reject")
                print(f"Semibot> 已拒绝审批 {payload.get('approval_id', approval_id)} ({payload.get('status', 'rejected')})")
            except Exception as exc:
                print(f"Semibot> 拒绝审批失败: {exc}")
            return True
        return False

    if args.message:
        if _handle_approval_command(args.message):
            return EXIT_SUCCESS
        show_indicator = bool(sys.stdout.isatty() and not args.json)
        try:
            result = _run_with_wait_indicator(
                show_indicator,
                lambda: _chat_send_first_turn_via_runtime(
                    args,
                    message=args.message,
                    session_id=resolved_session_id,
                    base_url=runtime_url,
                ),
            )
        except Exception as exc:
            result = {
                "status": "failed",
                "session_id": resolved_session_id,
                "agent_id": args.agent_id,
                "final_response": "",
                "error": str(exc),
            }
        if args.json:
            _print_json(result)
        else:
            final_response = _sanitize_terminal_text(str(result.get("final_response") or ""))
            error = _sanitize_terminal_text(str(result.get("error") or ""))
            print(final_response if final_response else f"I encountered an error: {error}")
            pending = _extract_pending_approval_ids(result)
            if pending:
                print(f"Semibot> 待审批: {', '.join(pending)}")
                print("Semibot> 继续执行前请运行: /approve <id> 或 /reject <id>")
        return EXIT_SUCCESS if result.get("status") == "completed" else EXIT_EXTERNAL_ERROR

    session_initialized = False

    while True:
        try:
            user_input = input("You> ").strip()
        except EOFError:
            print("")
            break
        except KeyboardInterrupt:
            print("")
            break

        if not user_input:
            continue
        if user_input.lower() in {"exit", "quit", "q"}:
            break
        if _handle_approval_command(user_input):
            continue

        show_indicator = bool(sys.stdout.isatty() and not args.json)
        try:
            if not session_initialized:
                result = _run_with_wait_indicator(
                    show_indicator,
                    lambda: _chat_send_first_turn_via_runtime(
                        args,
                        message=user_input,
                        session_id=resolved_session_id,
                        base_url=runtime_url,
                    ),
                )
                session_initialized = True
            else:
                result = _run_with_wait_indicator(
                    show_indicator,
                    lambda: _chat_in_session_via_runtime(
                        args,
                        message=user_input,
                        session_id=resolved_session_id,
                        base_url=runtime_url,
                    ),
                )
        except Exception as exc:
            result = {
                "status": "failed",
                "session_id": resolved_session_id,
                "agent_id": args.agent_id,
                "final_response": "",
                "error": str(exc),
            }
        if args.json:
            _print_json(result)
        else:
            final_response = _sanitize_terminal_text(str(result.get("final_response") or ""))
            error = _sanitize_terminal_text(str(result.get("error") or ""))
            print(f"Semibot> {final_response if final_response else f'I encountered an error: {error}'}")
            pending = _extract_pending_approval_ids(result)
            if pending:
                print(f"Semibot> 待审批: {', '.join(pending)}")
                print("Semibot> 执行 /approve <id> 后再重新发起原任务。")

    return EXIT_SUCCESS


def cmd_run(args: argparse.Namespace) -> int:
    runtime_url = _runtime_base_url(args)
    ready_error = _require_runtime_server(runtime_url)
    if ready_error:
        _print_json(
            _error_payload(
                resource="run",
                action="connect",
                code="RUNTIME_UNAVAILABLE",
                message=ready_error,
            )
        )
        return EXIT_EXTERNAL_ERROR

    try:
        result = _chat_start_via_runtime(
            args,
            message=args.task,
            session_id=args.session_id,
            base_url=runtime_url,
        )
    except Exception as exc:
        result = {
            "status": "failed",
            "session_id": args.session_id,
            "agent_id": args.agent_id,
            "final_response": "",
            "error": str(exc),
        }

    _print_json(
        {
            "version": CLI_VERSION,
            "mode": "run",
            "task": args.task,
            "accepted_at": datetime.now(UTC).isoformat(),
            "runtime_url": runtime_url,
            **result,
        }
    )
    return EXIT_SUCCESS if result.get("status") == "completed" else EXIT_EXTERNAL_ERROR


def _parse_cron_jobs_json(raw: str | None) -> tuple[list[dict[str, Any]] | None, str | None]:
    if not raw:
        return None, None
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        return None, "invalid --cron-jobs-json, expected JSON array"
    if not isinstance(parsed, list):
        return None, "invalid --cron-jobs-json, expected JSON array"
    normalized = [
        {str(key): value for key, value in item.items()}
        for item in parsed
        if isinstance(item, dict)
    ]
    return normalized, None


def cmd_serve_daemon(args: argparse.Namespace) -> int:
    cron_jobs: list[dict[str, Any]] | None = None
    if args.cron_jobs_json:
        parsed_cron_jobs, error = _parse_cron_jobs_json(args.cron_jobs_json)
        if error:
            _print_json(
                {
                    "version": CLI_VERSION,
                    "mode": "serve",
                    "error": error,
                }
            )
            return EXIT_ARGS_ERROR
        cron_jobs = parsed_cron_jobs

    app = create_app(
        db_path=args.db_path,
        rules_path=args.rules_path,
        heartbeat_interval_seconds=args.heartbeat_interval,
        cron_jobs=cron_jobs,
    )
    uvicorn.run(app, host=args.host, port=args.port, log_level="info")
    return 0


def _repo_root_from_cli() -> Path:
    return Path(__file__).resolve().parents[2]


def _runtime_main_script_path() -> Path:
    return _repo_root_from_cli() / "runtime" / "main.py"


def _runtime_python_executable() -> str:
    def _supports_uvicorn(python_exec: str) -> bool:
        try:
            result = subprocess.run(
                [python_exec, "-c", "import uvicorn"],
                capture_output=True,
                text=True,
            )
        except Exception:
            return False
        return result.returncode == 0

    candidates: list[str] = []
    runtime_python = _repo_root_from_cli() / "runtime" / ".venv" / "bin" / "python"
    if runtime_python.exists() and os.access(runtime_python, os.X_OK):
        candidates.append(str(runtime_python))
    if sys.executable:
        candidates.append(sys.executable)
    python3_bin = shutil.which("python3")
    if python3_bin:
        candidates.append(python3_bin)
    python_bin = shutil.which("python")
    if python_bin:
        candidates.append(python_bin)

    seen: set[str] = set()
    for candidate in candidates:
        if candidate in seen:
            continue
        seen.add(candidate)
        if _supports_uvicorn(candidate):
            return candidate
    return ""


def _run_pm2_command(command: list[str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(command, text=True, capture_output=True)


def _pm2_available() -> bool:
    return shutil.which("pm2") is not None


def _pm2_list() -> list[dict[str, Any]]:
    result = _run_pm2_command(["pm2", "jlist"])
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or result.stdout.strip() or "failed to query pm2 processes")
    raw = (result.stdout or "").strip()
    if not raw:
        return []
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as exc:
        start = raw.find("[")
        end = raw.rfind("]")
        if start == -1 or end == -1 or end <= start:
            raise RuntimeError(f"failed to parse pm2 jlist output: {exc}") from exc
        try:
            parsed = json.loads(raw[start : end + 1])
        except json.JSONDecodeError as inner_exc:
            raise RuntimeError(f"failed to parse pm2 jlist output: {inner_exc}") from inner_exc
    if isinstance(parsed, list):
        return [item for item in parsed if isinstance(item, dict)]
    return []


def _pm2_find_process(name: str) -> dict[str, Any] | None:
    for proc in _pm2_list():
        if str(proc.get("name", "")) == name:
            return proc
    return None


def _ensure_pm2() -> str | None:
    if _pm2_available():
        return None
    return "pm2 not found. install it first, e.g. `npm install -g pm2`."


def _serve_pm2_start_command(args: argparse.Namespace) -> list[str]:
    interpreter = _runtime_python_executable()
    if not interpreter:
        raise RuntimeError(
            "no python interpreter with `uvicorn` found. "
            "install runtime deps first (e.g. `cd runtime && pip install -e .`)."
        )
    command = [
        "pm2",
        "start",
        str(_runtime_main_script_path()),
        "--name",
        args.name,
        "--interpreter",
        interpreter,
        "--time",
        "--",
        "serve-daemon",
        "--host",
        args.host,
        "--port",
        str(args.port),
        "--db-path",
        args.db_path,
        "--rules-path",
        args.rules_path,
    ]
    if args.heartbeat_interval is not None:
        command.extend(["--heartbeat-interval", str(args.heartbeat_interval)])
    if args.cron_jobs_json:
        command.extend(["--cron-jobs-json", args.cron_jobs_json])
    return command


def _serve_pm2_action_error(action: str, message: str, *, details: dict[str, Any] | None = None) -> int:
    payload = _error_payload(
        resource="serve",
        action=action,
        code="PM2_COMMAND_FAILED",
        message=message,
    )
    if details:
        payload["details"] = details
    _print_json(payload)
    return EXIT_EXTERNAL_ERROR


def _pm2_delete_not_found(result: subprocess.CompletedProcess[str]) -> bool:
    text = f"{result.stdout}\n{result.stderr}".lower()
    return "not found" in text


def cmd_serve_start(args: argparse.Namespace) -> int:
    pm2_error = _ensure_pm2()
    if pm2_error:
        return _serve_pm2_action_error("start", pm2_error)

    _, cron_error = _parse_cron_jobs_json(args.cron_jobs_json)
    if cron_error:
        _print_json(
            _error_payload(
                resource="serve",
                action="start",
                code="INVALID_CRON_JOBS_JSON",
                message=cron_error,
            )
        )
        return EXIT_ARGS_ERROR

    try:
        existing = _pm2_find_process(args.name)
    except RuntimeError as exc:
        return _serve_pm2_action_error("start", str(exc))
    if existing:
        delete_result = _run_pm2_command(["pm2", "delete", args.name])
        if delete_result.returncode != 0 and not _pm2_delete_not_found(delete_result):
            return _serve_pm2_action_error(
                "start",
                f"failed to replace existing pm2 process (exit {delete_result.returncode})",
                details={"stdout_tail": _tail_lines(delete_result.stdout), "stderr_tail": _tail_lines(delete_result.stderr)},
            )

    try:
        start_command = _serve_pm2_start_command(args)
    except RuntimeError as exc:
        return _serve_pm2_action_error("start", str(exc))
    result = _run_pm2_command(start_command)
    if result.returncode != 0:
        return _serve_pm2_action_error(
            "start",
            f"failed to start runtime with pm2 (exit {result.returncode})",
            details={"stdout_tail": _tail_lines(result.stdout), "stderr_tail": _tail_lines(result.stderr)},
        )

    try:
        proc = _pm2_find_process(args.name)
    except RuntimeError:
        proc = None
    _print_json(
        {
            "version": CLI_VERSION,
            "mode": "serve",
            "action": "start",
            "ok": True,
            "pm2_name": args.name,
            "host": args.host,
            "port": args.port,
            "status": (proc.get("pm2_env") or {}).get("status") if isinstance(proc, dict) else "online",
            "pid": proc.get("pid") if isinstance(proc, dict) else None,
            "command": start_command,
        }
    )
    return EXIT_SUCCESS


def cmd_serve_stop(args: argparse.Namespace) -> int:
    pm2_error = _ensure_pm2()
    if pm2_error:
        return _serve_pm2_action_error("stop", pm2_error)

    port_cleanup = _kill_processes_on_port(args.port)

    try:
        existing = _pm2_find_process(args.name)
    except RuntimeError as exc:
        return _serve_pm2_action_error("stop", str(exc))
    if not existing:
        _print_json(
            {
                "version": CLI_VERSION,
                "mode": "serve",
                "action": "stop",
                "ok": True,
                "pm2_name": args.name,
                "already_stopped": True,
                "port_cleanup": port_cleanup,
            }
        )
        return EXIT_SUCCESS

    result = _run_pm2_command(["pm2", "delete", args.name])
    if result.returncode != 0 and not _pm2_delete_not_found(result):
        return _serve_pm2_action_error(
            "stop",
            f"failed to stop runtime with pm2 (exit {result.returncode})",
            details={"stdout_tail": _tail_lines(result.stdout), "stderr_tail": _tail_lines(result.stderr)},
        )

    _print_json(
        {
            "version": CLI_VERSION,
            "mode": "serve",
            "action": "stop",
            "ok": True,
            "pm2_name": args.name,
            "stopped": True,
            "port_cleanup": port_cleanup,
        }
    )
    return EXIT_SUCCESS


def cmd_serve_restart(args: argparse.Namespace) -> int:
    pm2_error = _ensure_pm2()
    if pm2_error:
        return _serve_pm2_action_error("restart", pm2_error)

    _, cron_error = _parse_cron_jobs_json(args.cron_jobs_json)
    if cron_error:
        _print_json(
            _error_payload(
                resource="serve",
                action="restart",
                code="INVALID_CRON_JOBS_JSON",
                message=cron_error,
            )
        )
        return EXIT_ARGS_ERROR

    try:
        existing = _pm2_find_process(args.name)
    except RuntimeError as exc:
        return _serve_pm2_action_error("restart", str(exc))
    if existing:
        stop_result = _run_pm2_command(["pm2", "delete", args.name])
        if stop_result.returncode != 0 and not _pm2_delete_not_found(stop_result):
            return _serve_pm2_action_error(
                "restart",
                f"failed to stop runtime with pm2 (exit {stop_result.returncode})",
                details={"stdout_tail": _tail_lines(stop_result.stdout), "stderr_tail": _tail_lines(stop_result.stderr)},
            )

    try:
        start_command = _serve_pm2_start_command(args)
    except RuntimeError as exc:
        return _serve_pm2_action_error("restart", str(exc))
    start_result = _run_pm2_command(start_command)
    if start_result.returncode != 0:
        return _serve_pm2_action_error(
            "restart",
            f"failed to restart runtime with pm2 (exit {start_result.returncode})",
            details={"stdout_tail": _tail_lines(start_result.stdout), "stderr_tail": _tail_lines(start_result.stderr)},
        )

    try:
        proc = _pm2_find_process(args.name)
    except RuntimeError:
        proc = None

    _print_json(
        {
            "version": CLI_VERSION,
            "mode": "serve",
            "action": "restart",
            "ok": True,
            "pm2_name": args.name,
            "host": args.host,
            "port": args.port,
            "status": (proc.get("pm2_env") or {}).get("status") if isinstance(proc, dict) else "online",
            "pid": proc.get("pid") if isinstance(proc, dict) else None,
            "command": start_command,
        }
    )
    return EXIT_SUCCESS


def _tail_lines(text: str, max_lines: int = 20) -> list[str]:
    lines = [line for line in text.splitlines() if line.strip()]
    if not lines:
        return []
    return lines[-max_lines:]


def _collect_pids_on_port(port: int) -> list[int]:
    if port <= 0:
        return []
    lsof_bin = shutil.which("lsof")
    if not lsof_bin:
        return []
    result = subprocess.run([lsof_bin, "-ti", f":{port}"], text=True, capture_output=True)
    raw = (result.stdout or "").strip()
    if not raw:
        return []
    pids: list[int] = []
    for line in raw.splitlines():
        token = line.strip()
        if not token:
            continue
        try:
            pids.append(int(token))
        except ValueError:
            continue
    return sorted(set(pid for pid in pids if pid > 0))


def _wait_for_exit(pids: list[int], timeout_seconds: float = 1.5) -> list[int]:
    if not pids:
        return []
    remaining = set(pids)
    deadline = time.time() + timeout_seconds
    while remaining and time.time() < deadline:
        alive: set[int] = set()
        for pid in remaining:
            try:
                os.kill(pid, 0)
            except OSError:
                continue
            alive.add(pid)
        if not alive:
            return []
        remaining = alive
        time.sleep(0.1)
    return sorted(remaining)


def _kill_pids(pids: list[int]) -> dict[str, Any]:
    target_pids = sorted(set(pid for pid in pids if pid > 0))
    if not target_pids:
        return {
            "target_pids": [],
            "terminated_pids": [],
            "killed_pids": [],
            "remaining_pids": [],
        }

    for pid in target_pids:
        try:
            os.kill(pid, signal.SIGTERM)
        except OSError:
            continue

    remaining_after_term = _wait_for_exit(target_pids, timeout_seconds=1.5)
    killed_pids: list[int] = []
    if remaining_after_term:
        for pid in remaining_after_term:
            try:
                os.kill(pid, signal.SIGKILL)
                killed_pids.append(pid)
            except OSError:
                continue
    remaining_after_kill = _wait_for_exit(remaining_after_term, timeout_seconds=1.0)
    terminated_pids = [pid for pid in target_pids if pid not in remaining_after_kill]
    return {
        "target_pids": target_pids,
        "terminated_pids": terminated_pids,
        "killed_pids": killed_pids,
        "remaining_pids": remaining_after_kill,
    }


def _kill_processes_on_port(port: int) -> dict[str, Any]:
    target_pids = _collect_pids_on_port(port)
    result = _kill_pids(target_pids)
    return {"port": port, **result}


def _ensure_pnpm() -> str | None:
    if shutil.which("pnpm"):
        return None
    return "pnpm not found. install it first, e.g. `npm install -g pnpm`."


def _ui_pm2_action_error(action: str, message: str, *, details: dict[str, Any] | None = None) -> int:
    payload = _error_payload(
        resource="ui",
        action=action,
        code="PM2_COMMAND_FAILED",
        message=message,
    )
    if details:
        payload["details"] = details
    _print_json(payload)
    return EXIT_EXTERNAL_ERROR


def _ui_pm2_process_names(name_prefix: str) -> dict[str, str]:
    return {
        "api": f"{name_prefix}-api",
        "web": f"{name_prefix}-web",
    }


def _ui_pm2_start_command(
    *,
    service: str,
    process_name: str,
    project_root: Path,
) -> list[str]:
    env_bootstrap = (
        "set -a; "
        "if [ -f .env.local ]; then source .env.local; "
        "elif [ -f .env ]; then source .env; "
        "fi; "
        "set +a; "
    )
    if service == "api":
        run_command = "pnpm --filter @semibot/api dev"
    elif service == "web":
        run_command = "pnpm --filter @semibot/web dev"
    else:
        raise RuntimeError(f"unsupported ui service: {service}")
    shell_command = f"{env_bootstrap}{run_command}"
    return [
        "pm2",
        "start",
        "bash",
        "--name",
        process_name,
        "--cwd",
        str(project_root),
        "--time",
        "--",
        "-lc",
        shell_command,
    ]


def _ui_pm2_process_summary(name: str) -> dict[str, Any]:
    try:
        proc = _pm2_find_process(name)
    except RuntimeError:
        proc = None
    if not isinstance(proc, dict):
        return {"name": name, "status": "stopped", "pid": None}
    pm2_env = proc.get("pm2_env") if isinstance(proc.get("pm2_env"), dict) else {}
    return {
        "name": name,
        "status": pm2_env.get("status") or "online",
        "pid": proc.get("pid"),
    }


def cmd_ui(args: argparse.Namespace) -> int:
    action = str(args.ui_action)
    project_root = _repo_root_from_cli()
    pm2_error = _ensure_pm2()
    if pm2_error:
        return _ui_pm2_action_error(action, pm2_error)
    if action in {"start", "restart"}:
        pnpm_error = _ensure_pnpm()
        if pnpm_error:
            return _ui_pm2_action_error(action, pnpm_error)

    api_pkg = project_root / "apps" / "api" / "package.json"
    web_pkg = project_root / "apps" / "web" / "package.json"
    missing = [str(path) for path in [api_pkg, web_pkg] if not path.exists()]
    if missing:
        _print_json(
            _error_payload(
                resource="ui",
                action=action,
                code="UI_PROJECT_MISSING",
                message="required UI/API workspace packages not found",
            )
        )
        return EXIT_NOT_FOUND

    names = _ui_pm2_process_names(args.name_prefix)
    steps: list[dict[str, Any]] = []
    port_cleanup: list[dict[str, Any]] = []
    runtime_name = str(getattr(args, "runtime_name", "semibot-runtime"))
    with_runtime = bool(getattr(args, "with_runtime", True))
    api_port = int(getattr(args, "api_port", _default_api_port()))
    web_port = int(getattr(args, "web_port", _default_web_port()))

    runtime_args = argparse.Namespace(
        name=runtime_name,
        host=str(getattr(args, "runtime_host", "127.0.0.1")),
        port=int(getattr(args, "runtime_port", 8765)),
        db_path=str(getattr(args, "runtime_db_path", _default_db_path())),
        rules_path=str(getattr(args, "runtime_rules_path", _default_rules_path())),
        heartbeat_interval=getattr(args, "runtime_heartbeat_interval", None),
        cron_jobs_json=getattr(args, "runtime_cron_jobs_json", None),
    )

    def _stop_one(name: str) -> tuple[bool, dict[str, Any] | None]:
        try:
            existing = _pm2_find_process(name)
        except RuntimeError as exc:
            return False, {"message": str(exc)}
        if not existing:
            return True, {"already_stopped": True}
        result = _run_pm2_command(["pm2", "delete", name])
        if result.returncode != 0 and not _pm2_delete_not_found(result):
            return False, {
                "message": f"failed to stop pm2 process `{name}` (exit {result.returncode})",
                "stdout_tail": _tail_lines(result.stdout),
                "stderr_tail": _tail_lines(result.stderr),
            }
        return True, {"stopped": True}

    def _start_one(service: str, name: str) -> tuple[bool, dict[str, Any]]:
        try:
            command = _ui_pm2_start_command(service=service, process_name=name, project_root=project_root)
        except RuntimeError as exc:
            return False, {"message": str(exc)}
        result = _run_pm2_command(command)
        if result.returncode != 0:
            return False, {
                "message": f"failed to start pm2 process `{name}` (exit {result.returncode})",
                "command": command,
                "stdout_tail": _tail_lines(result.stdout),
                "stderr_tail": _tail_lines(result.stderr),
            }
        return True, {"command": command}

    def _runtime_stop() -> tuple[bool, dict[str, Any] | None]:
        return _stop_one(runtime_args.name)

    def _runtime_start() -> tuple[bool, dict[str, Any]]:
        try:
            command = _serve_pm2_start_command(runtime_args)
        except RuntimeError as exc:
            return False, {"message": str(exc)}
        result = _run_pm2_command(command)
        if result.returncode != 0:
            return False, {
                "message": f"failed to start pm2 process `{runtime_args.name}` (exit {result.returncode})",
                "command": command,
                "stdout_tail": _tail_lines(result.stdout),
                "stderr_tail": _tail_lines(result.stderr),
            }
        return True, {"command": command}

    if action == "start":
        if with_runtime:
            ok, detail = _runtime_stop()
            if not ok:
                return _ui_pm2_action_error(action, str((detail or {}).get("message", "unknown error")), details=detail)
            ok, detail = _runtime_start()
            if not ok:
                return _ui_pm2_action_error(action, str(detail.get("message", "unknown error")), details=detail)
            steps.append({"step": "start", "service": "runtime", "pm2_name": runtime_args.name, **detail})
        for service, name in names.items():
            ok, detail = _stop_one(name)
            if not ok:
                return _ui_pm2_action_error(action, str((detail or {}).get("message", "unknown error")), details=detail)
            ok, detail = _start_one(service, name)
            if not ok:
                return _ui_pm2_action_error(action, str(detail.get("message", "unknown error")), details=detail)
            steps.append({"step": "start", "service": service, "pm2_name": name, **detail})
    elif action == "stop":
        for service, name in names.items():
            ok, detail = _stop_one(name)
            if not ok:
                return _ui_pm2_action_error(action, str((detail or {}).get("message", "unknown error")), details=detail)
            steps.append({"step": "stop", "service": service, "pm2_name": name, **(detail or {})})
        if with_runtime:
            ok, detail = _runtime_stop()
            if not ok:
                return _ui_pm2_action_error(action, str((detail or {}).get("message", "unknown error")), details=detail)
            steps.append({"step": "stop", "service": "runtime", "pm2_name": runtime_args.name, **(detail or {})})
            port_cleanup.append(_kill_processes_on_port(runtime_args.port))
        port_cleanup.append(_kill_processes_on_port(api_port))
        port_cleanup.append(_kill_processes_on_port(web_port))
    elif action == "restart":
        if with_runtime:
            ok, detail = _runtime_stop()
            if not ok:
                return _ui_pm2_action_error(action, str((detail or {}).get("message", "unknown error")), details=detail)
            steps.append({"step": "stop", "service": "runtime", "pm2_name": runtime_args.name, **(detail or {})})
            port_cleanup.append(_kill_processes_on_port(runtime_args.port))
            ok, detail = _runtime_start()
            if not ok:
                return _ui_pm2_action_error(action, str(detail.get("message", "unknown error")), details=detail)
            steps.append({"step": "start", "service": "runtime", "pm2_name": runtime_args.name, **detail})
        for service, name in names.items():
            ok, detail = _stop_one(name)
            if not ok:
                return _ui_pm2_action_error(action, str((detail or {}).get("message", "unknown error")), details=detail)
            steps.append({"step": "stop", "service": service, "pm2_name": name, **(detail or {})})
        port_cleanup.append(_kill_processes_on_port(api_port))
        port_cleanup.append(_kill_processes_on_port(web_port))
        for service, name in names.items():
            ok, detail = _start_one(service, name)
            if not ok:
                return _ui_pm2_action_error(action, str(detail.get("message", "unknown error")), details=detail)
            steps.append({"step": "start", "service": service, "pm2_name": name, **detail})
    else:
        _print_json(
            _error_payload(
                resource="ui",
                action=action,
                code="UI_ACTION_INVALID",
                message=f"unsupported ui action: {action}",
            )
        )
        return EXIT_ARGS_ERROR

    _print_json(
        {
            "version": CLI_VERSION,
            "mode": "ui",
            "action": action,
            "ok": True,
            "project_root": str(project_root),
            "pm2_name_prefix": args.name_prefix,
            "runtime": {
                "enabled": with_runtime,
                "pm2_name": runtime_args.name,
                "host": runtime_args.host,
                "port": runtime_args.port,
            },
            "port_cleanup": port_cleanup,
            "services": (["runtime"] if with_runtime else []) + list(names.keys()),
            "processes": (
                [_ui_pm2_process_summary(runtime_args.name)] if with_runtime else []
            ) + [_ui_pm2_process_summary(name) for name in names.values()],
            "steps": steps,
        }
    )
    return EXIT_SUCCESS


def cmd_skill_list(_args: argparse.Namespace) -> int:
    registry = create_default_registry()
    skills_path = Path(_default_skills_path()).expanduser()
    local_skill_dirs = sorted([p.name for p in skills_path.iterdir() if p.is_dir()]) if skills_path.exists() else []
    _print_json(
        {
            "version": CLI_VERSION,
            "resource": "skill",
            "action": "list",
            "tools": registry.list_tools(),
            "skills": registry.list_skills(),
            "local_skill_dirs": local_skill_dirs,
        }
    )
    return EXIT_SUCCESS


def cmd_skills_validate(args: argparse.Namespace) -> int:
    target = Path(args.target).expanduser()
    if target.is_dir():
        skill_dir = target
    else:
        skill_dir = Path(args.skills_path).expanduser() / args.target
    skill_md = skill_dir / "SKILL.md"

    ok = skill_dir.exists() and skill_dir.is_dir() and skill_md.exists()
    _print_json(
        {
            "version": CLI_VERSION,
            "resource": "skills",
            "action": "validate",
            "target": str(args.target),
            "resolved_path": str(skill_dir),
            "ok": ok,
            "checks": {
                "skill_dir_exists": skill_dir.exists(),
                "skill_md_exists": skill_md.exists(),
            },
        }
    )
    return EXIT_SUCCESS if ok else EXIT_NOT_FOUND


def cmd_skills_install(args: argparse.Namespace) -> int:
    source = Path(args.source).expanduser()
    skills_root = Path(args.skills_path).expanduser()
    skills_root.mkdir(parents=True, exist_ok=True)

    if not source.exists():
        _print_json(
            _error_payload(
                resource="skills",
                action="install",
                code="SOURCE_NOT_FOUND",
                message=f"source path not found: {source}",
            )
        )
        return EXIT_NOT_FOUND
    if not source.is_dir():
        _print_json(
            _error_payload(
                resource="skills",
                action="install",
                code="SOURCE_INVALID",
                message="source must be a local directory containing SKILL.md",
            )
        )
        return EXIT_ARGS_ERROR

    if not (source / "SKILL.md").exists():
        _print_json(
            _error_payload(
                resource="skills",
                action="install",
                code="SKILL_MD_MISSING",
                message="source directory must contain SKILL.md",
            )
        )
        return EXIT_ARGS_ERROR

    target_name = args.name or source.name
    target_dir = skills_root / target_name
    if target_dir.exists():
        if not args.force:
            _print_json(
                _error_payload(
                    resource="skills",
                    action="install",
                    code="TARGET_EXISTS",
                    message=f"target skill already exists: {target_name} (use --force to overwrite)",
                )
            )
            return EXIT_CONFIG_ERROR
        shutil.rmtree(target_dir)

    shutil.copytree(source, target_dir)
    _print_json(
        {
            "version": CLI_VERSION,
            "resource": "skills",
            "action": "install",
            "ok": True,
            "name": target_name,
            "source": str(source),
            "target": str(target_dir),
        }
    )
    return EXIT_SUCCESS


def cmd_skills_remove(args: argparse.Namespace) -> int:
    skill_dir = Path(args.skills_path).expanduser() / args.name
    if not skill_dir.exists():
        _print_json(
            _error_payload(
                resource="skills",
                action="remove",
                code="SKILL_NOT_FOUND",
                message=f"skill not found: {args.name}",
            )
        )
        return EXIT_NOT_FOUND

    confirmed = bool(getattr(args, "yes", False) or getattr(args, "confirm_yes", False))
    if not confirmed:
        _print_json(
            _error_payload(
                resource="skills",
                action="remove",
                code="CONFIRMATION_REQUIRED",
                message="re-run with --yes to remove skill directory",
            )
        )
        return EXIT_ARGS_ERROR

    shutil.rmtree(skill_dir)
    _print_json(
        {
            "version": CLI_VERSION,
            "resource": "skills",
            "action": "remove",
            "ok": True,
            "name": args.name,
            "path": str(skill_dir),
        }
    )
    return EXIT_SUCCESS


def cmd_tools_list(_args: argparse.Namespace) -> int:
    registry = create_default_registry()
    _print_json(
        {
            "version": CLI_VERSION,
            "resource": "tools",
            "action": "list",
            "count": len(registry.list_tools()),
            "items": registry.list_tools(),
        }
    )
    return EXIT_SUCCESS


def cmd_tools_run(args: argparse.Namespace) -> int:
    registry = create_default_registry()
    params_raw, error = _parse_json_arg(args.args, field_name="args")
    if error:
        _print_json(
            _error_payload(
                resource="tools",
                action="run",
                code="ARGS_INVALID",
                message=error,
            )
        )
        return EXIT_ARGS_ERROR
    params = params_raw if isinstance(params_raw, dict) else {"value": params_raw}
    result = asyncio.run(registry.execute(args.tool_name, params))
    _print_json(
        {
            "version": CLI_VERSION,
            "resource": "tools",
            "action": "run",
            "tool_name": args.tool_name,
            "ok": bool(result.success),
            "result": result.result,
            "error": result.error,
            "metadata": result.metadata,
        }
    )
    return EXIT_SUCCESS if result.success else EXIT_EXTERNAL_ERROR


def _read_mcp_config(path: str) -> tuple[dict[str, Any] | None, str | None]:
    config_path = Path(path).expanduser()
    if not config_path.exists():
        return None, f"mcp config not found: {config_path}"
    try:
        data = json.loads(config_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        return None, f"invalid mcp config json: {exc}"
    if not isinstance(data, dict):
        return None, "mcp config root must be an object"
    return data, None


def _normalize_mcp_items(config: dict[str, Any]) -> list[dict[str, Any]]:
    servers = config.get("servers", {})
    if not isinstance(servers, dict):
        return []
    items: list[dict[str, Any]] = []
    for name, raw in servers.items():
        if not isinstance(raw, dict):
            continue
        transport = str(raw.get("transport") or ("stdio" if raw.get("command") else "http")).lower()
        endpoint = raw.get("url")
        if endpoint is None and raw.get("command"):
            args = raw.get("args") if isinstance(raw.get("args"), list) else []
            endpoint = " ".join([str(raw.get("command"))] + [str(item) for item in args])
        items.append(
            {
                "name": str(name),
                "transport": transport,
                "endpoint": str(endpoint or ""),
                "has_headers": isinstance(raw.get("headers"), dict),
            }
        )
    return items


def cmd_mcp_list(args: argparse.Namespace) -> int:
    config, error = _read_mcp_config(args.mcp_path)
    if error:
        _print_json(
            _error_payload(
                resource="mcp",
                action="list",
                code="MCP_CONFIG_ERROR",
                message=error,
            )
        )
        return EXIT_CONFIG_ERROR
    items = _normalize_mcp_items(config or {})
    _print_json(
        {
            "version": CLI_VERSION,
            "resource": "mcp",
            "action": "list",
            "config_path": str(Path(args.mcp_path).expanduser()),
            "count": len(items),
            "items": items,
        }
    )
    return EXIT_SUCCESS


def cmd_mcp_test(args: argparse.Namespace) -> int:
    config, error = _read_mcp_config(args.mcp_path)
    if error:
        _print_json(
            _error_payload(
                resource="mcp",
                action="test",
                code="MCP_CONFIG_ERROR",
                message=error,
            )
        )
        return EXIT_CONFIG_ERROR
    items = _normalize_mcp_items(config or {})
    target = next((item for item in items if item["name"] == args.server_name), None)
    if target is None:
        _print_json(
            _error_payload(
                resource="mcp",
                action="test",
                code="MCP_SERVER_NOT_FOUND",
                message=f"server not found: {args.server_name}",
            )
        )
        return EXIT_NOT_FOUND

    transport = str(target["transport"])
    endpoint = str(target["endpoint"])
    ok = False
    checks: dict[str, bool] = {}
    if transport == "stdio":
        command = endpoint.split(" ", maxsplit=1)[0] if endpoint else ""
        command_ok = bool(command and (Path(command).exists() or shutil.which(command)))
        checks["command_resolvable"] = command_ok
        ok = command_ok
    else:
        parsed = urlparse(endpoint)
        url_ok = parsed.scheme in {"http", "https"}
        checks["url_valid"] = url_ok
        ok = url_ok

    _print_json(
        {
            "version": CLI_VERSION,
            "resource": "mcp",
            "action": "test",
            "server_name": args.server_name,
            "transport": transport,
            "endpoint": endpoint,
            "ok": ok,
            "checks": checks,
        }
    )
    return EXIT_SUCCESS if ok else EXIT_EXTERNAL_ERROR


def cmd_mcp_sync(args: argparse.Namespace) -> int:
    config, error = _read_mcp_config(args.mcp_path)
    if error:
        _print_json(
            _error_payload(
                resource="mcp",
                action="sync",
                code="MCP_CONFIG_ERROR",
                message=error,
            )
        )
        return EXIT_CONFIG_ERROR
    items = _normalize_mcp_items(config or {})
    _print_json(
        {
            "version": CLI_VERSION,
            "resource": "mcp",
            "action": "sync",
            "ok": True,
            "servers_discovered": len(items),
            "items": items,
        }
    )
    return EXIT_SUCCESS


def cmd_mcp_call(args: argparse.Namespace) -> int:
    config, error = _read_mcp_config(getattr(args, "mcp_path", _default_mcp_path()))
    if error:
        _print_json(
            _error_payload(
                resource="mcp",
                action="call",
                code="MCP_CONFIG_ERROR",
                message=error,
            )
        )
        return EXIT_CONFIG_ERROR

    params_raw, parse_error = _parse_json_arg(args.args, field_name="args")
    if parse_error:
        _print_json(
            _error_payload(
                resource="mcp",
                action="call",
                code="ARGS_INVALID",
                message=parse_error,
            )
        )
        return EXIT_ARGS_ERROR
    call_args = params_raw if isinstance(params_raw, dict) else {"value": params_raw}

    servers = config.get("servers", {}) if isinstance(config, dict) else {}
    if not isinstance(servers, dict):
        servers = {}
    raw_server = servers.get(args.server_name)
    if not isinstance(raw_server, dict):
        _print_json(
            _error_payload(
                resource="mcp",
                action="call",
                code="MCP_SERVER_NOT_FOUND",
                message=f"server not found: {args.server_name}",
            )
        )
        return EXIT_NOT_FOUND

    transport = str(raw_server.get("transport") or ("stdio" if raw_server.get("command") else "http")).lower()
    endpoint = str(raw_server.get("url") or "")
    if not endpoint and raw_server.get("command"):
        raw_args = raw_server.get("args")
        command_args = [str(item) for item in raw_args] if isinstance(raw_args, list) else []
        endpoint = " ".join([str(raw_server.get("command"))] + command_args)

    try:
        from src.mcp.bootstrap import setup_mcp_client
        from src.orchestrator.context import McpServerDefinition
    except Exception as exc:
        _print_json(
            _error_payload(
                resource="mcp",
                action="call",
                code="MCP_IMPORT_ERROR",
                message=str(exc),
            )
        )
        return EXIT_EXTERNAL_ERROR

    server = McpServerDefinition(
        id=args.server_name,
        name=args.server_name,
        endpoint=endpoint,
        transport=transport,
        auth_config={"api_key": raw_server.get("api_key")} if raw_server.get("api_key") else {},
    )

    async def _call() -> Any:
        client = await setup_mcp_client([server])
        if client is None or not client.is_connected(server.id):
            raise RuntimeError(f"failed to connect MCP server: {server.id}")
        try:
            return await client.call_tool(server.id, args.tool_name, call_args)
        finally:
            await client.close_all()

    try:
        result = asyncio.run(_call())
    except Exception as exc:
        _print_json(
            _error_payload(
                resource="mcp",
                action="call",
                code="MCP_CALL_FAILED",
                message=str(exc),
            )
        )
        return EXIT_EXTERNAL_ERROR

    _print_json(
        {
            "version": CLI_VERSION,
            "resource": "mcp",
            "action": "call",
            "ok": True,
            "server_name": args.server_name,
            "tool_name": args.tool_name,
            "result": result,
        }
    )
    return EXIT_SUCCESS


def _event_to_json(event: Event) -> dict[str, Any]:
    return {
        "event_id": event.event_id,
        "event_type": event.event_type,
        "source": event.source,
        "subject": event.subject,
        "timestamp": event.timestamp.isoformat(),
        "risk_hint": event.risk_hint,
        "payload": event.payload,
    }


def _parse_iso_datetime(raw: str, *, field_name: str) -> tuple[datetime | None, str | None]:
    try:
        parsed = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError as exc:
        return None, f"invalid {field_name}: {exc}"
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=UTC)
    return parsed, None


def _session_id_from_event(event: Event) -> str | None:
    payload_session = event.payload.get("session_id") if isinstance(event.payload, dict) else None
    if isinstance(payload_session, str) and payload_session.strip():
        return payload_session.strip()
    if isinstance(event.subject, str) and event.subject.strip():
        if event.subject.startswith(("local_", "chat_", "sess_")):
            return event.subject
    return None


def cmd_events_list(args: argparse.Namespace) -> int:
    store = EventStore(db_path=args.db_path)
    since_dt: datetime | None = None
    if args.since:
        since_dt, error = _parse_iso_datetime(args.since, field_name="since")
        if error:
            _print_json(
                _error_payload(
                    resource="events",
                    action="list",
                    code="ARGS_INVALID",
                    message=error,
                )
            )
            return EXIT_ARGS_ERROR

    event_type = args.event_type or getattr(args, "type", None)
    events = store.list_events(
        limit=args.limit,
        event_type=event_type,
        since=since_dt,
    )
    _print_json(
        {
            "version": CLI_VERSION,
            "resource": "events",
            "action": "list",
            "since": args.since,
            "count": len(events),
            "items": [_event_to_json(event) for event in events],
        }
    )
    return EXIT_SUCCESS


def cmd_events_show(args: argparse.Namespace) -> int:
    store = EventStore(db_path=args.db_path)
    event = store.get_event(args.event_id)
    if event is None:
        _print_json(
            _error_payload(
                resource="events",
                action="show",
                code="EVENT_NOT_FOUND",
                message=f"event not found: {args.event_id}",
            )
        )
        return EXIT_NOT_FOUND
    _print_json(
        {
            "version": CLI_VERSION,
            "resource": "events",
            "action": "show",
            "item": _event_to_json(event),
        }
    )
    return EXIT_SUCCESS


def _build_event_engine(args: argparse.Namespace) -> EventEngine:
    return EventEngine(
        store=EventStore(db_path=args.db_path),
        rules_path=args.rules_path,
    )


def cmd_events_replay(args: argparse.Namespace) -> int:
    engine = _build_event_engine(args)
    if args.event_id:
        outcomes = asyncio.run(engine.replay_event(args.event_id))
        _print_json(
            {
                "version": CLI_VERSION,
                "resource": "events",
                "action": "replay",
                "event_id": args.event_id,
                "matched_rules": len(outcomes),
                "outcomes": [
                    {
                        "run_id": item.run_id,
                        "rule_id": item.rule_id,
                        "decision": item.decision,
                        "status": item.status,
                        "reason": item.reason,
                        "approval_id": item.approval_id,
                        "errors": item.errors,
                    }
                    for item in outcomes
                ],
            }
        )
        return EXIT_SUCCESS

    event_type = args.event_type or getattr(args, "type", None)
    if not event_type or not args.since:
        _print_json(
            _error_payload(
                resource="events",
                action="replay",
                code="ARGS_INVALID",
                message="provide <event_id> or --event-type/--type with --since",
            )
        )
        return EXIT_ARGS_ERROR

    since_dt, error = _parse_iso_datetime(args.since, field_name="since")
    if error:
        _print_json(
            _error_payload(
                resource="events",
                action="replay",
                code="ARGS_INVALID",
                message=error,
            )
        )
        return EXIT_ARGS_ERROR

    replayed = asyncio.run(engine.replay_by_type(event_type, since_dt or datetime.now(UTC)))
    _print_json(
        {
            "version": CLI_VERSION,
            "resource": "events",
            "action": "replay",
            "accepted": True,
            "event_type": event_type,
            "since": args.since,
            "replayed": replayed,
        }
    )
    return EXIT_SUCCESS


def cmd_events_clean(args: argparse.Namespace) -> int:
    store = EventStore(db_path=args.db_path)
    if args.before:
        before_dt, error = _parse_iso_datetime(args.before, field_name="before")
        if error:
            _print_json(
                _error_payload(
                    resource="events",
                    action="clean",
                    code="ARGS_INVALID",
                    message=error,
                )
            )
            return EXIT_ARGS_ERROR
    else:
        before_dt = datetime.now(UTC) - timedelta(days=30)

    if args.dry_run:
        counts = store.cleanup_events(before=before_dt, dry_run=True)
        _print_json(
            {
                "version": CLI_VERSION,
                "resource": "events",
                "action": "clean",
                "ok": True,
                "dry_run": True,
                "before": before_dt.isoformat(),
                "counts": counts,
            }
        )
        return EXIT_SUCCESS

    if not (args.yes or getattr(args, "confirm_yes", False)):
        _print_json(
            _error_payload(
                resource="events",
                action="clean",
                code="CONFIRMATION_REQUIRED",
                message="re-run with --yes to clean events",
            )
        )
        return EXIT_ARGS_ERROR

    counts = store.cleanup_events(before=before_dt, dry_run=False)
    _print_json(
        {
            "version": CLI_VERSION,
            "resource": "events",
            "action": "clean",
            "ok": True,
            "dry_run": False,
            "before": before_dt.isoformat(),
            "counts": counts,
        }
    )
    return EXIT_SUCCESS


def cmd_events_publish(args: argparse.Namespace) -> int:
    engine = _build_event_engine(args)
    payload_raw, error = _parse_json_arg(args.payload, field_name="payload")
    if error:
        _print_json(
            _error_payload(
                resource="events",
                action="publish",
                code="ARGS_INVALID",
                message=error,
            )
        )
        return EXIT_ARGS_ERROR
    payload = payload_raw if payload_raw is not None else {}
    event = Event(
        event_id=args.event_id or f"evt_cli_{int(datetime.now(UTC).timestamp() * 1000)}",
        event_type=args.event_type,
        source="cli",
        subject=args.subject,
        payload=payload if isinstance(payload, dict) else {"value": payload},
        idempotency_key=args.idempotency_key,
        risk_hint=args.risk_hint,
        timestamp=utc_now(),
    )
    outcomes = asyncio.run(engine.emit(event))
    _print_json(
        {
            "version": CLI_VERSION,
            "resource": "events",
            "action": "publish",
            "event_id": event.event_id,
            "matched_rules": len(outcomes),
        }
    )
    return EXIT_SUCCESS


def cmd_events_stats(args: argparse.Namespace) -> int:
    store = EventStore(db_path=args.db_path)
    since_dt = None
    if args.since:
        since_dt, error = _parse_iso_datetime(args.since, field_name="since")
        if error:
            _print_json(
                _error_payload(
                    resource="events",
                    action="stats",
                    code="ARGS_INVALID",
                    message=error,
                )
            )
            return EXIT_ARGS_ERROR
    metrics = store.get_metrics(since=since_dt)
    _print_json(
        {
            "version": CLI_VERSION,
            "resource": "events",
            "action": "stats",
            "since": args.since,
            "metrics": metrics,
        }
    )
    return EXIT_SUCCESS


def cmd_events_queue(args: argparse.Namespace) -> int:
    store = EventStore(db_path=args.db_path)
    rows = store.list_events(limit=1, event_type="rule.queue.telemetry")
    snapshot = rows[0].payload if rows else {}
    _print_json(
        {
            "version": CLI_VERSION,
            "resource": "events",
            "action": "queue",
            "snapshot": snapshot if isinstance(snapshot, dict) else {},
        }
    )
    return EXIT_SUCCESS


def cmd_memory_search(args: argparse.Namespace) -> int:
    query = args.query.strip().lower()
    store = EventStore(db_path=args.db_path)
    events = store.list_events(limit=args.limit)

    def _match(event: Event) -> bool:
        haystack = " ".join(
            [
                event.event_type,
                event.subject or "",
                json.dumps(event.payload, ensure_ascii=False),
            ]
        ).lower()
        return query in haystack

    matched = [event for event in events if _match(event)]
    if args.category:
        matched = [
            event
            for event in matched
            if isinstance(event.payload, dict) and str(event.payload.get("category", "")).lower() == args.category.lower()
        ]

    _print_json(
        {
            "version": CLI_VERSION,
            "resource": "memory",
            "action": "search",
            "query": args.query,
            "count": len(matched),
            "items": [
                {
                    "event_id": event.event_id,
                    "event_type": event.event_type,
                    "subject": event.subject,
                    "timestamp": event.timestamp.isoformat(),
                    "payload": event.payload,
                }
                for event in matched
            ],
        }
    )
    return EXIT_SUCCESS


def cmd_memory_write(args: argparse.Namespace) -> int:
    metadata: dict[str, Any] = {}
    if args.metadata:
        parsed, error = _parse_json_arg(args.metadata, field_name="metadata")
        if error:
            _print_json(
                _error_payload(
                    resource="memory",
                    action="write",
                    code="ARGS_INVALID",
                    message=error,
                )
            )
            return EXIT_ARGS_ERROR
        if isinstance(parsed, dict):
            metadata = parsed

    store = EventStore(db_path=args.db_path)
    event = Event(
        event_id=f"evt_memory_{int(time.time() * 1000)}",
        event_type="memory.write.manual",
        source="cli.memory",
        subject=args.session_id,
        payload={
            "category": args.category,
            "importance": args.importance,
            "content": args.content,
            "metadata": metadata,
            "session_id": args.session_id,
        },
        risk_hint="low",
        timestamp=utc_now(),
    )
    store.append_event(event)
    _print_json(
        {
            "version": CLI_VERSION,
            "resource": "memory",
            "action": "write",
            "ok": True,
            "event_id": event.event_id,
        }
    )
    return EXIT_SUCCESS


def cmd_memory_sessions(args: argparse.Namespace) -> int:
    store = EventStore(db_path=args.db_path)
    events = store.list_session_events(args.session_id, limit=args.limit)
    _print_json(
        {
            "version": CLI_VERSION,
            "resource": "memory",
            "action": "sessions",
            "session_id": args.session_id,
            "count": len(events),
            "items": [_event_to_json(event) for event in events],
        }
    )
    return EXIT_SUCCESS


def cmd_memory_consolidate(args: argparse.Namespace) -> int:
    store = EventStore(db_path=args.db_path)
    events = store.list_session_events(args.session_id, limit=args.limit)
    if not events:
        _print_json(
            _error_payload(
                resource="memory",
                action="consolidate",
                code="SESSION_NOT_FOUND",
                message=f"no events found for session: {args.session_id}",
            )
        )
        return EXIT_NOT_FOUND

    snippets = []
    for event in events[-10:]:
        content = ""
        if isinstance(event.payload, dict):
            content = str(event.payload.get("message") or event.payload.get("final_response") or "")
        snippets.append(f"[{event.event_type}] {content}".strip())
    summary = "\n".join(item for item in snippets if item)[:4000]

    if args.dry_run:
        _print_json(
            {
                "version": CLI_VERSION,
                "resource": "memory",
                "action": "consolidate",
                "dry_run": True,
                "session_id": args.session_id,
                "candidate": {
                    "category": args.category,
                    "importance": args.importance,
                    "content": summary,
                },
            }
        )
        return EXIT_SUCCESS

    event = Event(
        event_id=f"evt_memory_{int(time.time() * 1000)}",
        event_type="memory.write.important",
        source="cli.memory",
        subject=args.session_id,
        payload={
            "category": args.category,
            "importance": args.importance,
            "content": summary,
            "session_id": args.session_id,
        },
        risk_hint="low",
        timestamp=utc_now(),
    )
    store.append_event(event)
    _print_json(
        {
            "version": CLI_VERSION,
            "resource": "memory",
            "action": "consolidate",
            "dry_run": False,
            "session_id": args.session_id,
            "event_id": event.event_id,
            "ok": True,
        }
    )
    return EXIT_SUCCESS


def cmd_memory_stats(args: argparse.Namespace) -> int:
    store = EventStore(db_path=args.db_path)
    events = store.list_events(limit=args.limit)
    memory_events = [event for event in events if event.event_type.startswith("memory.write.")]
    by_category: dict[str, int] = {}
    for event in memory_events:
        category = "unknown"
        if isinstance(event.payload, dict):
            raw = event.payload.get("category")
            if isinstance(raw, str) and raw.strip():
                category = raw.strip()
        by_category[category] = by_category.get(category, 0) + 1

    _print_json(
        {
            "version": CLI_VERSION,
            "resource": "memory",
            "action": "stats",
            "events_scanned": len(events),
            "memory_events": len(memory_events),
            "by_category": by_category,
        }
    )
    return EXIT_SUCCESS


def _load_json_file(path: str, *, field_name: str) -> tuple[Any | None, str | None]:
    file_path = Path(path).expanduser()
    if not file_path.exists():
        return None, f"{field_name} not found: {file_path}"
    try:
        return json.loads(file_path.read_text(encoding="utf-8")), None
    except json.JSONDecodeError as exc:
        return None, f"invalid {field_name} json: {exc}"


def _validate_rule_data(raw: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    if not str(raw.get("id") or raw.get("name") or "").strip():
        errors.append("missing rule id/name")
    if not str(raw.get("event_type") or "").strip():
        errors.append("missing event_type")
    action_mode = str(raw.get("action_mode") or "auto")
    if action_mode not in {"ask", "suggest", "auto"}:
        errors.append(f"invalid action_mode: {action_mode}")
    risk_level = str(raw.get("risk_level") or "low")
    if risk_level not in {"low", "medium", "high"}:
        errors.append(f"invalid risk_level: {risk_level}")
    conditions = raw.get("conditions", {})
    if not isinstance(conditions, dict):
        errors.append("conditions must be object")
    actions = raw.get("actions", [])
    if not isinstance(actions, list):
        errors.append("actions must be list")
    else:
        for idx, action in enumerate(actions):
            if not isinstance(action, dict):
                errors.append(f"actions[{idx}] must be object")
                continue
            if not str(action.get("action_type") or "").strip():
                errors.append(f"actions[{idx}] missing action_type")
    return errors


def _rule_files_for_path(path: str) -> list[Path]:
    target = Path(path).expanduser()
    if target.is_file():
        return [target]
    if not target.exists():
        return []
    return sorted(target.glob("*.json"))


def cmd_rules_lint(args: argparse.Namespace) -> int:
    raw, error = _load_json_file(args.file, field_name="rule file")
    if error:
        _print_json(
            _error_payload(resource="rules", action="lint", code="RULE_FILE_ERROR", message=error)
        )
        return EXIT_NOT_FOUND

    candidates = raw if isinstance(raw, list) else [raw]
    validation_errors: list[str] = []
    for item in candidates:
        if not isinstance(item, dict):
            validation_errors.append("rule item must be object")
            continue
        validation_errors.extend(_validate_rule_data(item))

    _print_json(
        {
            "version": CLI_VERSION,
            "resource": "rules",
            "action": "lint",
            "ok": len(validation_errors) == 0,
            "errors": validation_errors,
        }
    )
    return EXIT_SUCCESS if not validation_errors else EXIT_ARGS_ERROR


def cmd_rules_create(args: argparse.Namespace) -> int:
    raw, error = _load_json_file(args.file, field_name="rule file")
    if error:
        _print_json(
            _error_payload(resource="rules", action="create", code="RULE_FILE_ERROR", message=error)
        )
        return EXIT_NOT_FOUND
    if not isinstance(raw, dict):
        _print_json(
            _error_payload(
                resource="rules",
                action="create",
                code="RULE_FILE_INVALID",
                message="rule file must contain one JSON object",
            )
        )
        return EXIT_ARGS_ERROR

    errors = _validate_rule_data(raw)
    if errors:
        _print_json(
            _error_payload(
                resource="rules",
                action="create",
                code="RULE_VALIDATION_ERROR",
                message="; ".join(errors),
            )
        )
        return EXIT_ARGS_ERROR

    rule_id = str(raw.get("id") or raw.get("name")).strip()
    existing = load_rules(args.rules_path)
    if any(rule.id == rule_id or rule.name == rule_id for rule in existing):
        _print_json(
            _error_payload(
                resource="rules",
                action="create",
                code="RULE_ALREADY_EXISTS",
                message=f"rule already exists: {rule_id}",
            )
        )
        return EXIT_CONFIG_ERROR

    target = Path(args.rules_path).expanduser()
    if target.suffix == ".json":
        if target.exists():
            existing_data, parse_error = _load_json_file(str(target), field_name="rules path")
            if parse_error:
                _print_json(
                    _error_payload(
                        resource="rules",
                        action="create",
                        code="RULES_PATH_INVALID",
                        message=parse_error,
                    )
                )
                return EXIT_CONFIG_ERROR
            if isinstance(existing_data, list):
                existing_data.append(raw)
            elif isinstance(existing_data, dict):
                existing_data = [existing_data, raw]
            else:
                existing_data = [raw]
            target.write_text(json.dumps(existing_data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
            saved_path = target
        else:
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(json.dumps([raw], ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
            saved_path = target
    else:
        target.mkdir(parents=True, exist_ok=True)
        saved_path = target / f"{rule_id}.json"
        saved_path.write_text(json.dumps(raw, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    _print_json(
        {
            "version": CLI_VERSION,
            "resource": "rules",
            "action": "create",
            "ok": True,
            "rule_id": rule_id,
            "path": str(saved_path),
        }
    )
    return EXIT_SUCCESS


def cmd_rules_update(args: argparse.Namespace) -> int:
    patch_raw, error = _load_json_file(args.file, field_name="rule patch file")
    if error:
        _print_json(
            _error_payload(resource="rules", action="update", code="RULE_FILE_ERROR", message=error)
        )
        return EXIT_NOT_FOUND
    if not isinstance(patch_raw, dict):
        _print_json(
            _error_payload(
                resource="rules",
                action="update",
                code="RULE_FILE_INVALID",
                message="rule patch must be a JSON object",
            )
        )
        return EXIT_ARGS_ERROR

    for file in _rule_files_for_path(args.rules_path):
        file_data, parse_error = _load_json_file(str(file), field_name="rule file")
        if parse_error:
            continue
        changed = False
        if isinstance(file_data, list):
            for item in file_data:
                if not isinstance(item, dict):
                    continue
                item_id = str(item.get("id") or item.get("name") or "").strip()
                if item_id != args.rule_id:
                    continue
                item.update(patch_raw)
                errors = _validate_rule_data(item)
                if errors:
                    _print_json(
                        _error_payload(
                            resource="rules",
                            action="update",
                            code="RULE_VALIDATION_ERROR",
                            message="; ".join(errors),
                        )
                    )
                    return EXIT_ARGS_ERROR
                changed = True
        elif isinstance(file_data, dict):
            item_id = str(file_data.get("id") or file_data.get("name") or "").strip()
            if item_id == args.rule_id:
                file_data.update(patch_raw)
                errors = _validate_rule_data(file_data)
                if errors:
                    _print_json(
                        _error_payload(
                            resource="rules",
                            action="update",
                            code="RULE_VALIDATION_ERROR",
                            message="; ".join(errors),
                        )
                    )
                    return EXIT_ARGS_ERROR
                changed = True

        if changed:
            file.write_text(json.dumps(file_data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
            _print_json(
                {
                    "version": CLI_VERSION,
                    "resource": "rules",
                    "action": "update",
                    "ok": True,
                    "rule_id": args.rule_id,
                    "path": str(file),
                }
            )
            return EXIT_SUCCESS

    _print_json(
        _error_payload(
            resource="rules",
            action="update",
            code="RULE_NOT_FOUND",
            message=f"rule not found: {args.rule_id}",
        )
    )
    return EXIT_NOT_FOUND


def cmd_rules_test(args: argparse.Namespace) -> int:
    event_raw, event_error = _load_json_file(args.event_file, field_name="event file")
    rules_raw, rules_error = _load_json_file(args.rules_file, field_name="rules file")
    if event_error or rules_error:
        _print_json(
            _error_payload(
                resource="rules",
                action="test",
                code="ARGS_INVALID",
                message=event_error or rules_error or "invalid input",
            )
        )
        return EXIT_ARGS_ERROR
    if not isinstance(event_raw, dict):
        _print_json(
            _error_payload(
                resource="rules",
                action="test",
                code="EVENT_INVALID",
                message="event file must be a JSON object",
            )
        )
        return EXIT_ARGS_ERROR

    temp_rules_path = Path(args.rules_file).expanduser()
    rules = load_rules(str(temp_rules_path))
    event = Event(
        event_id=str(event_raw.get("event_id") or "evt_rule_test"),
        event_type=str(event_raw.get("event_type") or ""),
        source=str(event_raw.get("source") or "cli.rules.test"),
        subject=event_raw.get("subject") if isinstance(event_raw.get("subject"), str) else None,
        payload=event_raw.get("payload") if isinstance(event_raw.get("payload"), dict) else {},
        risk_hint=event_raw.get("risk_hint") if isinstance(event_raw.get("risk_hint"), str) else None,
        timestamp=utc_now(),
    )
    evaluator = RuleEvaluator()
    outcomes: list[dict[str, Any]] = []
    for rule in rules:
        if not rule.is_active:
            continue
        if rule.event_type not in {event.event_type, "*"}:
            continue
        passed = evaluator.evaluate(rule.conditions, event)
        decision = "skip" if not passed else rule.action_mode
        if decision == "auto" and rule.risk_level == "high":
            decision = "ask"
        outcomes.append(
            {
                "rule_id": rule.id,
                "rule_name": rule.name,
                "matched": passed,
                "decision": decision,
                "risk_level": rule.risk_level,
            }
        )

    _print_json(
        {
            "version": CLI_VERSION,
            "resource": "rules",
            "action": "test",
            "event_type": event.event_type,
            "count": len(outcomes),
            "outcomes": outcomes,
        }
    )
    return EXIT_SUCCESS


def cmd_rules_list(args: argparse.Namespace) -> int:
    rules = load_rules(args.rules_path)
    if args.active:
        rules = [rule for rule in rules if rule.is_active]
    _print_json(
        {
            "version": CLI_VERSION,
            "resource": "rules",
            "action": "list",
            "rules_path": str(Path(args.rules_path).expanduser()),
            "count": len(rules),
            "items": rules_to_json(rules),
        }
    )
    return EXIT_SUCCESS


def cmd_rules_show(args: argparse.Namespace) -> int:
    rules = load_rules(args.rules_path)
    target = next((rule for rule in rules if rule.id == args.rule_id or rule.name == args.rule_id), None)
    if target is None:
        _print_json(
            _error_payload(
                resource="rules",
                action="show",
                code="RULE_NOT_FOUND",
                message=f"rule not found: {args.rule_id}",
            )
        )
        return EXIT_NOT_FOUND
    _print_json(
        {
            "version": CLI_VERSION,
            "resource": "rules",
            "action": "show",
            "item": rules_to_json([target])[0],
        }
    )
    return EXIT_SUCCESS


def cmd_rules_toggle(args: argparse.Namespace) -> int:
    if not args.active and not (args.yes or getattr(args, "confirm_yes", False)):
        _print_json(
            _error_payload(
                resource="rules",
                action="disable",
                code="CONFIRMATION_REQUIRED",
                message="re-run with --yes to disable rule",
            )
        )
        return EXIT_ARGS_ERROR
    updated = set_rule_active(args.rules_path, args.rule_id, active=args.active)
    _print_json(
        {
            "version": CLI_VERSION,
            "resource": "rules",
            "action": "enable" if args.active else "disable",
            "rule_id": args.rule_id,
            "updated": updated,
            "rules_path": str(Path(args.rules_path).expanduser()),
        }
    )
    return EXIT_SUCCESS if updated else EXIT_NOT_FOUND


def _approval_to_json(item: Any) -> dict[str, Any]:
    return {
        "approval_id": item.approval_id,
        "rule_id": item.rule_id,
        "event_id": item.event_id,
        "risk_level": item.risk_level,
        "status": item.status,
        "created_at": item.created_at.isoformat(),
        "resolved_at": item.resolved_at.isoformat() if item.resolved_at else None,
    }


def cmd_approvals_list(args: argparse.Namespace) -> int:
    store = EventStore(db_path=args.db_path)
    approvals = store.list_approvals(status=args.status, limit=args.limit)
    _print_json(
        {
            "version": CLI_VERSION,
            "resource": "approvals",
            "action": "list",
            "count": len(approvals),
            "items": [_approval_to_json(item) for item in approvals],
        }
    )
    return EXIT_SUCCESS


def cmd_approvals_show(args: argparse.Namespace) -> int:
    store = EventStore(db_path=args.db_path)
    item = store.get_approval(args.approval_id)
    if item is None:
        _print_json(
            _error_payload(
                resource="approvals",
                action="show",
                code="APPROVAL_NOT_FOUND",
                message=f"approval not found: {args.approval_id}",
            )
        )
        return EXIT_NOT_FOUND
    _print_json(
        {
            "version": CLI_VERSION,
            "resource": "approvals",
            "action": "show",
            "item": _approval_to_json(item),
        }
    )
    return EXIT_SUCCESS


def cmd_approvals_resolve(args: argparse.Namespace) -> int:
    store = EventStore(db_path=args.db_path)
    current = store.get_approval(args.approval_id)
    if current is None:
        _print_json(
            _error_payload(
                resource="approvals",
                action=args.decision,
                code="APPROVAL_NOT_FOUND",
                message=f"approval not found: {args.approval_id}",
            )
        )
        return EXIT_NOT_FOUND
    if current.status != "pending":
        _print_json(
            _error_payload(
                resource="approvals",
                action=args.decision,
                code="APPROVAL_NOT_PENDING",
                message=f"approval status is {current.status}, only pending can be resolved",
            )
        )
        return EXIT_APPROVAL_BLOCKED

    engine = EventEngine(store=store, rules_path=args.rules_path)
    approval = asyncio.run(engine.resolve_approval(args.approval_id, args.decision))
    _print_json(
        {
            "version": CLI_VERSION,
            "resource": "approvals",
            "action": args.decision,
            "approval_id": args.approval_id,
            "found": approval is not None,
            "status": approval.status if approval else None,
            "reason": args.reason,
        }
    )
    return EXIT_SUCCESS if approval else EXIT_NOT_FOUND


def cmd_approvals_watch(args: argparse.Namespace) -> int:
    store = EventStore(db_path=args.db_path)
    known: dict[str, str] = {}
    started = time.time()
    try:
        while True:
            approvals = store.list_approvals(limit=args.limit)
            changed: list[dict[str, Any]] = []
            for item in approvals:
                status = str(item.status)
                prev = known.get(item.approval_id)
                if prev != status:
                    known[item.approval_id] = status
                    changed.append(_approval_to_json(item))

            for item in changed:
                _print_json(
                    {
                        "version": CLI_VERSION,
                        "resource": "approvals",
                        "action": "watch",
                        "item": item,
                    }
                )

            if args.timeout and (time.time() - started) >= args.timeout:
                break
            time.sleep(max(args.interval, 0.1))
    except KeyboardInterrupt:
        pass

    _print_json(
        {
            "version": CLI_VERSION,
            "resource": "approvals",
            "action": "watch",
            "ok": True,
            "stopped": True,
        }
    )
    return EXIT_SUCCESS


def cmd_sessions_list(args: argparse.Namespace) -> int:
    store = EventStore(db_path=args.db_path)
    sessions = store.list_sessions(limit=args.limit)
    _print_json(
        {
            "version": CLI_VERSION,
            "resource": "sessions",
            "action": "list",
            "count": len(sessions),
            "items": sessions,
        }
    )
    return EXIT_SUCCESS


def cmd_sessions_show(args: argparse.Namespace) -> int:
    store = EventStore(db_path=args.db_path)
    events = store.list_session_events(args.session_id, limit=args.limit)
    if not events:
        _print_json(
            _error_payload(
                resource="sessions",
                action="show",
                code="SESSION_NOT_FOUND",
                message=f"session not found: {args.session_id}",
            )
        )
        return EXIT_NOT_FOUND
    _print_json(
        {
            "version": CLI_VERSION,
            "resource": "sessions",
            "action": "show",
            "session_id": args.session_id,
            "count": len(events),
            "items": [_event_to_json(event) for event in events],
        }
    )
    return EXIT_SUCCESS


def cmd_sessions_export(args: argparse.Namespace) -> int:
    store = EventStore(db_path=args.db_path)
    events = store.list_session_events(args.session_id, limit=args.limit)
    if not events:
        _print_json(
            _error_payload(
                resource="sessions",
                action="export",
                code="SESSION_NOT_FOUND",
                message=f"session not found: {args.session_id}",
            )
        )
        return EXIT_NOT_FOUND

    out_path = Path(args.out).expanduser()
    out_path.parent.mkdir(parents=True, exist_ok=True)
    if args.format == "json":
        payload = {
            "session_id": args.session_id,
            "count": len(events),
            "items": [_event_to_json(event) for event in events],
        }
        out_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    else:
        lines = [f"# Session {args.session_id}", ""]
        for event in events:
            lines.append(f"## {event.timestamp.isoformat()} `{event.event_type}`")
            lines.append("")
            lines.append(f"- source: `{event.source}`")
            if event.subject:
                lines.append(f"- subject: `{event.subject}`")
            lines.append(f"- payload: `{json.dumps(event.payload, ensure_ascii=False)}`")
            lines.append("")
        out_path.write_text("\n".join(lines).rstrip() + "\n", encoding="utf-8")

    _print_json(
        {
            "version": CLI_VERSION,
            "resource": "sessions",
            "action": "export",
            "session_id": args.session_id,
            "format": args.format,
            "out": str(out_path),
            "count": len(events),
            "ok": True,
        }
    )
    return EXIT_SUCCESS


def cmd_sessions_resume(args: argparse.Namespace) -> int:
    if args.message:
        runtime_url = _runtime_base_url(args)
        ready_error = _require_runtime_server(runtime_url)
        if ready_error:
            _print_json(
                _error_payload(
                    resource="sessions",
                    action="resume",
                    code="RUNTIME_UNAVAILABLE",
                    message=ready_error,
                )
            )
            return EXIT_EXTERNAL_ERROR

        try:
            result = _chat_in_session_via_runtime(
                args,
                message=args.message,
                session_id=args.session_id,
                base_url=runtime_url,
            )
        except Exception as exc:
            result = {
                "status": "failed",
                "session_id": args.session_id,
                "agent_id": args.agent_id,
                "final_response": "",
                "error": str(exc),
            }
        _print_json(
            {
                "version": CLI_VERSION,
                "resource": "sessions",
                "action": "resume",
                "session_id": args.session_id,
                "message": args.message,
                "runtime_url": runtime_url,
                "result": result,
            }
        )
        return EXIT_SUCCESS if result.get("status") == "completed" else EXIT_EXTERNAL_ERROR

    _print_json(
        {
            "version": CLI_VERSION,
            "resource": "sessions",
            "action": "resume",
            "session_id": args.session_id,
            "ok": True,
            "hint": "use `semibot chat --session-id <id>` to continue interactively",
        }
    )
    return EXIT_SUCCESS


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="semibot", description="Semibot V2 CLI")
    parser.add_argument(
        "--output",
        choices=["json", "table", "yaml", "ndjson"],
        default="table",
        help="Output format",
    )
    parser.add_argument("--trace-id", default=None, help="Optional trace ID for audit correlation")
    parser.add_argument("--json", action="store_true", help="Force JSON output")
    parser.add_argument("--no-color", action="store_true", help="Disable ANSI colors")
    parser.add_argument(
        "--log-level",
        choices=["DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"],
        default=_default_log_level(),
        help="Runtime log level (default: CRITICAL)",
    )
    parser.add_argument("--yes", action="store_true", help="Skip confirmation prompts")
    subparsers = parser.add_subparsers(dest="command", required=True)

    version_parser = subparsers.add_parser("version", help="Show Semibot CLI version")
    version_parser.set_defaults(func=cmd_version)

    doctor_parser = subparsers.add_parser("doctor", help="Validate local runtime health")
    doctor_parser.add_argument("--db-path", default=_default_db_path(), help="SQLite DB path")
    doctor_parser.add_argument("--rules-path", default=_default_rules_path(), help="Rules path")
    doctor_parser.add_argument("--skills-path", default=_default_skills_path(), help="Skills path")
    doctor_parser.set_defaults(func=cmd_doctor)

    configure_parser = subparsers.add_parser("configure", help="Inspect and mutate config.toml")
    configure_subparsers = configure_parser.add_subparsers(
        dest="configure_command",
        required=False,
    )
    configure_parser.add_argument(
        "--config-path",
        default=_default_config_path(),
        help="Config TOML path",
    )
    configure_parser.add_argument(
        "--section",
        default=None,
        help="Jump into one section in interactive mode (e.g. runtime, llm)",
    )
    configure_parser.add_argument(
        "--non-interactive",
        action="store_true",
        help="Disable interactive wizard and print config summary",
    )
    configure_parser.set_defaults(func=cmd_configure)

    configure_show_parser = configure_subparsers.add_parser("show", help="Show full config")
    configure_show_parser.add_argument(
        "--config-path",
        default=_default_config_path(),
        help="Config TOML path",
    )
    configure_show_parser.set_defaults(func=cmd_configure_show)

    configure_get_parser = configure_subparsers.add_parser("get", help="Get a config value by dotted key")
    configure_get_parser.add_argument("key", help="Dotted key, e.g. llm.default_model")
    configure_get_parser.add_argument(
        "--config-path",
        default=_default_config_path(),
        help="Config TOML path",
    )
    configure_get_parser.set_defaults(func=cmd_configure_get)

    configure_set_parser = configure_subparsers.add_parser("set", help="Set a config value by dotted key")
    configure_set_parser.add_argument("key", help="Dotted key, e.g. llm.default_model")
    configure_set_parser.add_argument("value", help="Value to set")
    configure_set_parser.add_argument(
        "--type",
        dest="value_type",
        choices=["auto", "string", "int", "float", "bool", "json"],
        default="auto",
        help="How to parse value",
    )
    configure_set_parser.add_argument(
        "--config-path",
        default=_default_config_path(),
        help="Config TOML path",
    )
    configure_set_parser.set_defaults(func=cmd_configure_set)

    configure_unset_parser = configure_subparsers.add_parser("unset", help="Remove a config key")
    configure_unset_parser.add_argument("key", help="Dotted key to remove")
    configure_unset_parser.add_argument(
        "--config-path",
        default=_default_config_path(),
        help="Config TOML path",
    )
    configure_unset_parser.set_defaults(func=cmd_configure_unset)

    init_parser = subparsers.add_parser("init", help="Initialize local Semibot home")
    init_parser.add_argument("--db-path", default=_default_db_path(), help="SQLite DB path")
    init_parser.add_argument("--rules-path", default=_default_rules_path(), help="Rules path")
    init_parser.set_defaults(func=cmd_init)

    chat_parser = subparsers.add_parser("chat", help="Start CLI chat mode")
    chat_parser.add_argument("--db-path", default=_default_db_path(), help="SQLite DB path")
    chat_parser.add_argument("--rules-path", default=_default_rules_path(), help="Rules path")
    chat_parser.add_argument("--agent-id", default="semibot", help="Agent ID")
    chat_parser.add_argument("--session-id", default=None, help="Session ID override")
    chat_parser.add_argument("--model", default=None, help="Model override")
    chat_parser.add_argument("--system-prompt", default=None, help="Agent system prompt override")
    chat_parser.add_argument(
        "--server-url",
        default=str(os.getenv("SEMIBOT_RUNTIME_URL", "http://127.0.0.1:8765")),
        help="Runtime service base URL",
    )
    chat_parser.add_argument("--message", default=None, help="Run one chat turn and exit")
    chat_parser.add_argument(
        "--json",
        action="store_true",
        help="Print assistant result in JSON for each turn",
    )
    chat_parser.set_defaults(func=cmd_chat)

    run_parser = subparsers.add_parser("run", help="Run a single task")
    run_parser.add_argument("task", help="Task prompt")
    run_parser.add_argument("--agent-id", default="semibot", help="Agent ID")
    run_parser.add_argument("--session-id", default=None, help="Session ID override")
    run_parser.add_argument(
        "--server-url",
        default=str(os.getenv("SEMIBOT_RUNTIME_URL", "http://127.0.0.1:8765")),
        help="Runtime service base URL",
    )
    run_parser.set_defaults(func=cmd_run)

    serve_parser = subparsers.add_parser("serve", help="Manage runtime service via pm2")
    serve_subparsers = serve_parser.add_subparsers(dest="serve_action", required=True)

    serve_start_parser = serve_subparsers.add_parser("start", help="Start runtime service in background")
    serve_start_parser.add_argument("--name", default="semibot-runtime", help="PM2 process name")
    serve_start_parser.add_argument("--host", default="127.0.0.1", help="Bind host")
    serve_start_parser.add_argument("--port", type=int, default=8765, help="Bind port")
    serve_start_parser.add_argument("--db-path", default=_default_db_path(), help="SQLite DB path")
    serve_start_parser.add_argument("--rules-path", default=_default_rules_path(), help="Rules path")
    serve_start_parser.add_argument(
        "--heartbeat-interval",
        type=float,
        default=None,
        help="Optional heartbeat interval seconds",
    )
    serve_start_parser.add_argument(
        "--cron-jobs-json",
        default=None,
        help="Optional cron jobs JSON array",
    )
    serve_start_parser.set_defaults(func=cmd_serve_start)

    serve_stop_parser = serve_subparsers.add_parser("stop", help="Stop runtime service")
    serve_stop_parser.add_argument("--name", default="semibot-runtime", help="PM2 process name")
    serve_stop_parser.add_argument("--port", type=int, default=8765, help="Runtime bind port to cleanup")
    serve_stop_parser.set_defaults(func=cmd_serve_stop)

    serve_restart_parser = serve_subparsers.add_parser("restart", help="Restart runtime service")
    serve_restart_parser.add_argument("--name", default="semibot-runtime", help="PM2 process name")
    serve_restart_parser.add_argument("--host", default="127.0.0.1", help="Bind host")
    serve_restart_parser.add_argument("--port", type=int, default=8765, help="Bind port")
    serve_restart_parser.add_argument("--db-path", default=_default_db_path(), help="SQLite DB path")
    serve_restart_parser.add_argument("--rules-path", default=_default_rules_path(), help="Rules path")
    serve_restart_parser.add_argument(
        "--heartbeat-interval",
        type=float,
        default=None,
        help="Optional heartbeat interval seconds",
    )
    serve_restart_parser.add_argument(
        "--cron-jobs-json",
        default=None,
        help="Optional cron jobs JSON array",
    )
    serve_restart_parser.set_defaults(func=cmd_serve_restart)

    serve_daemon_parser = subparsers.add_parser("serve-daemon", help=argparse.SUPPRESS)
    serve_daemon_parser.add_argument("--host", default="127.0.0.1", help=argparse.SUPPRESS)
    serve_daemon_parser.add_argument("--port", type=int, default=8765, help=argparse.SUPPRESS)
    serve_daemon_parser.add_argument("--db-path", default=_default_db_path(), help=argparse.SUPPRESS)
    serve_daemon_parser.add_argument("--rules-path", default=_default_rules_path(), help=argparse.SUPPRESS)
    serve_daemon_parser.add_argument("--heartbeat-interval", type=float, default=None, help=argparse.SUPPRESS)
    serve_daemon_parser.add_argument("--cron-jobs-json", default=None, help=argparse.SUPPRESS)
    serve_daemon_parser.set_defaults(func=cmd_serve_daemon)

    ui_parser = subparsers.add_parser("ui", help="Manage UI/API stack via pm2")
    ui_subparsers = ui_parser.add_subparsers(dest="ui_action", required=True)

    ui_start_parser = ui_subparsers.add_parser("start", help="Start runtime/UI/API services in background")
    ui_start_parser.add_argument("--name-prefix", default="semibot-ui", help="PM2 process name prefix")
    ui_start_parser.add_argument("--api-port", type=int, default=_default_api_port(), help="API port")
    ui_start_parser.add_argument("--web-port", type=int, default=_default_web_port(), help="Web port")
    ui_start_parser.add_argument("--runtime-name", default="semibot-runtime", help="Runtime PM2 process name")
    ui_start_parser.add_argument("--runtime-host", default="127.0.0.1", help="Runtime bind host")
    ui_start_parser.add_argument("--runtime-port", type=int, default=8765, help="Runtime bind port")
    ui_start_parser.add_argument("--runtime-db-path", default=_default_db_path(), help="Runtime SQLite DB path")
    ui_start_parser.add_argument("--runtime-rules-path", default=_default_rules_path(), help="Runtime rules path")
    ui_start_parser.add_argument(
        "--runtime-heartbeat-interval",
        type=float,
        default=None,
        help="Runtime heartbeat interval seconds",
    )
    ui_start_parser.add_argument(
        "--runtime-cron-jobs-json",
        default=None,
        help="Runtime cron jobs JSON array",
    )
    ui_start_parser.add_argument(
        "--no-runtime",
        dest="with_runtime",
        action="store_false",
        help="Do not manage runtime process in this command",
    )
    ui_start_parser.set_defaults(with_runtime=True)
    ui_start_parser.set_defaults(func=cmd_ui)

    ui_stop_parser = ui_subparsers.add_parser("stop", help="Stop runtime/UI/API services")
    ui_stop_parser.add_argument("--name-prefix", default="semibot-ui", help="PM2 process name prefix")
    ui_stop_parser.add_argument("--api-port", type=int, default=_default_api_port(), help="API port")
    ui_stop_parser.add_argument("--web-port", type=int, default=_default_web_port(), help="Web port")
    ui_stop_parser.add_argument("--runtime-name", default="semibot-runtime", help="Runtime PM2 process name")
    ui_stop_parser.add_argument("--runtime-port", type=int, default=8765, help="Runtime bind port")
    ui_stop_parser.add_argument(
        "--no-runtime",
        dest="with_runtime",
        action="store_false",
        help="Do not manage runtime process in this command",
    )
    ui_stop_parser.set_defaults(with_runtime=True)
    ui_stop_parser.set_defaults(func=cmd_ui)

    ui_restart_parser = ui_subparsers.add_parser("restart", help="Restart runtime/UI/API services")
    ui_restart_parser.add_argument("--name-prefix", default="semibot-ui", help="PM2 process name prefix")
    ui_restart_parser.add_argument("--api-port", type=int, default=_default_api_port(), help="API port")
    ui_restart_parser.add_argument("--web-port", type=int, default=_default_web_port(), help="Web port")
    ui_restart_parser.add_argument("--runtime-name", default="semibot-runtime", help="Runtime PM2 process name")
    ui_restart_parser.add_argument("--runtime-host", default="127.0.0.1", help="Runtime bind host")
    ui_restart_parser.add_argument("--runtime-port", type=int, default=8765, help="Runtime bind port")
    ui_restart_parser.add_argument("--runtime-db-path", default=_default_db_path(), help="Runtime SQLite DB path")
    ui_restart_parser.add_argument("--runtime-rules-path", default=_default_rules_path(), help="Runtime rules path")
    ui_restart_parser.add_argument(
        "--runtime-heartbeat-interval",
        type=float,
        default=None,
        help="Runtime heartbeat interval seconds",
    )
    ui_restart_parser.add_argument(
        "--runtime-cron-jobs-json",
        default=None,
        help="Runtime cron jobs JSON array",
    )
    ui_restart_parser.add_argument(
        "--no-runtime",
        dest="with_runtime",
        action="store_false",
        help="Do not manage runtime process in this command",
    )
    ui_restart_parser.set_defaults(with_runtime=True)
    ui_restart_parser.set_defaults(func=cmd_ui)

    skill_parser = subparsers.add_parser("skills", aliases=["skill"], help="Skill operations")
    skill_subparsers = skill_parser.add_subparsers(dest="skill_command", required=True)
    skill_list_parser = skill_subparsers.add_parser("list", help="List available tools/skills")
    skill_list_parser.set_defaults(func=cmd_skill_list)
    skill_install_parser = skill_subparsers.add_parser("install", help="Install a local skill directory")
    skill_install_parser.add_argument("source", help="Local directory path containing SKILL.md")
    skill_install_parser.add_argument("--name", default=None, help="Target installed skill name")
    skill_install_parser.add_argument("--skills-path", default=_default_skills_path(), help="Skills root path")
    skill_install_parser.add_argument("--force", action="store_true", help="Overwrite target if exists")
    skill_install_parser.set_defaults(func=cmd_skills_install)
    skill_validate_parser = skill_subparsers.add_parser("validate", help="Validate skill directory")
    skill_validate_parser.add_argument("target", help="Skill name under skills-path or absolute path")
    skill_validate_parser.add_argument("--skills-path", default=_default_skills_path(), help="Skills root path")
    skill_validate_parser.set_defaults(func=cmd_skills_validate)
    skill_remove_parser = skill_subparsers.add_parser("remove", help="Remove an installed skill")
    skill_remove_parser.add_argument("name", help="Installed skill name")
    skill_remove_parser.add_argument("--skills-path", default=_default_skills_path(), help="Skills root path")
    skill_remove_parser.add_argument("--yes", dest="confirm_yes", action="store_true", help="Skip confirmation prompts")
    skill_remove_parser.set_defaults(func=cmd_skills_remove)

    tools_parser = subparsers.add_parser("tools", help="Builtin tool operations")
    tools_subparsers = tools_parser.add_subparsers(dest="tools_command", required=True)
    tools_list_parser = tools_subparsers.add_parser("list", help="List available tools")
    tools_list_parser.set_defaults(func=cmd_tools_list)
    tools_run_parser = tools_subparsers.add_parser("run", help="Execute one tool by name")
    tools_run_parser.add_argument("tool_name", help="Tool name")
    tools_run_parser.add_argument("--args", default="{}", help="Tool args as JSON")
    tools_run_parser.set_defaults(func=cmd_tools_run)

    mcp_parser = subparsers.add_parser("mcp", help="MCP operations")
    mcp_subparsers = mcp_parser.add_subparsers(dest="mcp_command", required=True)
    mcp_list_parser = mcp_subparsers.add_parser("list", help="List configured MCP servers")
    mcp_list_parser.add_argument("--mcp-path", default=_default_mcp_path(), help="MCP config json path")
    mcp_list_parser.set_defaults(func=cmd_mcp_list)
    mcp_test_parser = mcp_subparsers.add_parser("test", help="Test one MCP server config")
    mcp_test_parser.add_argument("server_name", help="MCP server name in config")
    mcp_test_parser.add_argument("--mcp-path", default=_default_mcp_path(), help="MCP config json path")
    mcp_test_parser.set_defaults(func=cmd_mcp_test)
    mcp_sync_parser = mcp_subparsers.add_parser("sync", help="Reload MCP config from disk")
    mcp_sync_parser.add_argument("--mcp-path", default=_default_mcp_path(), help="MCP config json path")
    mcp_sync_parser.set_defaults(func=cmd_mcp_sync)
    mcp_call_parser = mcp_subparsers.add_parser("call", help="Call one MCP tool")
    mcp_call_parser.add_argument("server_name", help="MCP server name")
    mcp_call_parser.add_argument("tool_name", help="MCP tool name")
    mcp_call_parser.add_argument("--args", default="{}", help="Tool args as JSON")
    mcp_call_parser.add_argument("--mcp-path", default=_default_mcp_path(), help="MCP config json path")
    mcp_call_parser.set_defaults(func=cmd_mcp_call)

    memory_parser = subparsers.add_parser("memory", help="Memory operations")
    memory_subparsers = memory_parser.add_subparsers(dest="memory_command", required=True)
    memory_search_parser = memory_subparsers.add_parser("search", help="Search local memory events")
    memory_search_parser.add_argument("query", help="Search query")
    memory_search_parser.add_argument(
        "--db-path", default=_default_db_path(), help="SQLite DB path"
    )
    memory_search_parser.add_argument("--category", default=None, help="Optional category filter")
    memory_search_parser.add_argument("--limit", type=int, default=200, help="Max events to scan")
    memory_search_parser.set_defaults(func=cmd_memory_search)
    memory_write_parser = memory_subparsers.add_parser("write", help="Write one memory record")
    memory_write_parser.add_argument("--category", default="knowledge", help="Memory category")
    memory_write_parser.add_argument("--importance", type=float, default=0.5, help="Importance score 0-1")
    memory_write_parser.add_argument("--content", required=True, help="Memory content")
    memory_write_parser.add_argument("--metadata", default=None, help="Metadata JSON")
    memory_write_parser.add_argument("--session-id", default=None, help="Optional session ID")
    memory_write_parser.add_argument("--db-path", default=_default_db_path(), help="SQLite DB path")
    memory_write_parser.set_defaults(func=cmd_memory_write)
    memory_sessions_parser = memory_subparsers.add_parser("sessions", help="Show session memory context")
    memory_sessions_parser.add_argument("session_id", help="Session ID")
    memory_sessions_parser.add_argument("--limit", type=int, default=50, help="Max events")
    memory_sessions_parser.add_argument("--db-path", default=_default_db_path(), help="SQLite DB path")
    memory_sessions_parser.set_defaults(func=cmd_memory_sessions)
    memory_consolidate_parser = memory_subparsers.add_parser("consolidate", help="Consolidate one session into memory")
    memory_consolidate_parser.add_argument("session_id", help="Session ID")
    memory_consolidate_parser.add_argument("--dry-run", action="store_true", help="Do not persist memory")
    memory_consolidate_parser.add_argument("--limit", type=int, default=100, help="Max events to summarize")
    memory_consolidate_parser.add_argument("--category", default="project", help="Category for consolidated memory")
    memory_consolidate_parser.add_argument("--importance", type=float, default=0.7, help="Importance score 0-1")
    memory_consolidate_parser.add_argument("--db-path", default=_default_db_path(), help="SQLite DB path")
    memory_consolidate_parser.set_defaults(func=cmd_memory_consolidate)
    memory_stats_parser = memory_subparsers.add_parser("stats", help="Show memory stats")
    memory_stats_parser.add_argument("--db-path", default=_default_db_path(), help="SQLite DB path")
    memory_stats_parser.add_argument("--limit", type=int, default=5000, help="Max events to scan")
    memory_stats_parser.set_defaults(func=cmd_memory_stats)

    events_parser = subparsers.add_parser("events", help="Event operations")
    events_subparsers = events_parser.add_subparsers(dest="events_command", required=True)
    events_list_parser = events_subparsers.add_parser("list", help="List events")
    events_list_parser.add_argument(
        "--db-path",
        default=_default_db_path(),
        help="SQLite DB path",
    )
    events_list_parser.add_argument("--since", default=None, help="ISO8601 lower-bound timestamp")
    events_list_parser.add_argument("--type", default=None, help="Alias of --event-type")
    events_list_parser.add_argument("--event-type", default=None, help="Filter by event_type")
    events_list_parser.add_argument("--limit", type=int, default=20, help="Max rows")
    events_list_parser.set_defaults(func=cmd_events_list)
    events_show_parser = events_subparsers.add_parser("show", help="Show one event by ID")
    events_show_parser.add_argument("event_id", help="Event ID")
    events_show_parser.add_argument("--db-path", default=_default_db_path(), help="SQLite DB path")
    events_show_parser.set_defaults(func=cmd_events_show)
    events_replay_parser = events_subparsers.add_parser("replay", help="Replay one event by ID")
    events_replay_parser.add_argument("event_id", nargs="?", default=None, help="Event ID")
    events_replay_parser.add_argument("--event-type", default=None, help="Replay events by type")
    events_replay_parser.add_argument("--type", default=None, help="Alias of --event-type")
    events_replay_parser.add_argument("--since", default=None, help="ISO8601 lower-bound timestamp")
    events_replay_parser.add_argument(
        "--db-path", default=_default_db_path(), help="SQLite DB path"
    )
    events_replay_parser.add_argument(
        "--rules-path", default=_default_rules_path(), help="Rules path"
    )
    events_replay_parser.set_defaults(func=cmd_events_replay)
    events_publish_parser = events_subparsers.add_parser(
        "publish",
        aliases=["emit"],
        help="Publish one custom event",
    )
    events_publish_parser.add_argument("event_type", help="Event type")
    events_publish_parser.add_argument("--payload", default="{}", help="JSON payload string")
    events_publish_parser.add_argument("--subject", default=None, help="Event subject")
    events_publish_parser.add_argument("--event-id", default=None, help="Event ID override")
    events_publish_parser.add_argument("--idempotency-key", default=None, help="Idempotency key")
    events_publish_parser.add_argument("--risk-hint", default=None, help="Risk hint")
    events_publish_parser.add_argument(
        "--db-path", default=_default_db_path(), help="SQLite DB path"
    )
    events_publish_parser.add_argument(
        "--rules-path", default=_default_rules_path(), help="Rules path"
    )
    events_publish_parser.set_defaults(func=cmd_events_publish)
    events_clean_parser = events_subparsers.add_parser("clean", help="Clean old events")
    events_clean_parser.add_argument("--before", default=None, help="Delete records before this ISO8601 timestamp")
    events_clean_parser.add_argument("--dry-run", action="store_true", help="Only return delete counts")
    events_clean_parser.add_argument("--yes", dest="confirm_yes", action="store_true", help="Skip confirmation prompt")
    events_clean_parser.add_argument("--db-path", default=_default_db_path(), help="SQLite DB path")
    events_clean_parser.set_defaults(func=cmd_events_clean)
    events_stats_parser = events_subparsers.add_parser("stats", help="Show event engine metrics")
    events_stats_parser.add_argument("--db-path", default=_default_db_path(), help="SQLite DB path")
    events_stats_parser.add_argument("--since", default=None, help="ISO datetime filter")
    events_stats_parser.set_defaults(func=cmd_events_stats)
    events_queue_parser = events_subparsers.add_parser("queue", help="Show latest queue telemetry")
    events_queue_parser.add_argument("--db-path", default=_default_db_path(), help="SQLite DB path")
    events_queue_parser.set_defaults(func=cmd_events_queue)

    rules_parser = subparsers.add_parser("rules", help="Rule operations")
    rules_subparsers = rules_parser.add_subparsers(dest="rules_command", required=True)
    rules_list_parser = rules_subparsers.add_parser("list", help="List rules")
    rules_list_parser.add_argument(
        "--rules-path",
        default=_default_rules_path(),
        help="Rules file (.json) or directory",
    )
    rules_list_parser.add_argument("--active", action="store_true", help="Only show active rules")
    rules_list_parser.set_defaults(func=cmd_rules_list)
    rules_show_parser = rules_subparsers.add_parser("show", help="Show one rule")
    rules_show_parser.add_argument("rule_id", help="Rule ID or name")
    rules_show_parser.add_argument(
        "--rules-path", default=_default_rules_path(), help="Rules path"
    )
    rules_show_parser.set_defaults(func=cmd_rules_show)
    rules_enable_parser = rules_subparsers.add_parser("enable", help="Enable one rule")
    rules_enable_parser.add_argument("rule_id", help="Rule ID")
    rules_enable_parser.add_argument(
        "--rules-path", default=_default_rules_path(), help="Rules path"
    )
    rules_enable_parser.set_defaults(func=cmd_rules_toggle, active=True)
    rules_disable_parser = rules_subparsers.add_parser("disable", help="Disable one rule")
    rules_disable_parser.add_argument("rule_id", help="Rule ID")
    rules_disable_parser.add_argument(
        "--rules-path", default=_default_rules_path(), help="Rules path"
    )
    rules_disable_parser.add_argument("--yes", dest="confirm_yes", action="store_true", help="Skip confirmation")
    rules_disable_parser.set_defaults(func=cmd_rules_toggle, active=False)
    rules_create_parser = rules_subparsers.add_parser("create", help="Create one rule from JSON file")
    rules_create_parser.add_argument("--file", required=True, help="Rule JSON file path")
    rules_create_parser.add_argument("--rules-path", default=_default_rules_path(), help="Rules path")
    rules_create_parser.set_defaults(func=cmd_rules_create)
    rules_update_parser = rules_subparsers.add_parser("update", help="Update one rule by patch JSON file")
    rules_update_parser.add_argument("rule_id", help="Rule ID")
    rules_update_parser.add_argument("--file", required=True, help="Patch JSON file path")
    rules_update_parser.add_argument("--rules-path", default=_default_rules_path(), help="Rules path")
    rules_update_parser.set_defaults(func=cmd_rules_update)
    rules_lint_parser = rules_subparsers.add_parser("lint", help="Validate rule JSON file")
    rules_lint_parser.add_argument("--file", required=True, help="Rule JSON file")
    rules_lint_parser.set_defaults(func=cmd_rules_lint)
    rules_test_parser = rules_subparsers.add_parser("test", help="Test rule matching with one event fixture")
    rules_test_parser.add_argument("--event", dest="event_file", required=True, help="Event JSON fixture")
    rules_test_parser.add_argument("--rules", dest="rules_file", required=True, help="Rules JSON fixture")
    rules_test_parser.set_defaults(func=cmd_rules_test)

    approvals_parser = subparsers.add_parser("approvals", help="Approval operations")
    approvals_subparsers = approvals_parser.add_subparsers(dest="approvals_command", required=True)
    approvals_list_parser = approvals_subparsers.add_parser("list", help="List approvals")
    approvals_list_parser.add_argument(
        "--db-path", default=_default_db_path(), help="SQLite DB path"
    )
    approvals_list_parser.add_argument("--status", default=None, help="pending/approved/rejected")
    approvals_list_parser.add_argument("--limit", type=int, default=20, help="Max rows")
    approvals_list_parser.set_defaults(func=cmd_approvals_list)
    approvals_show_parser = approvals_subparsers.add_parser("show", help="Show one approval")
    approvals_show_parser.add_argument("approval_id", help="Approval ID")
    approvals_show_parser.add_argument(
        "--db-path", default=_default_db_path(), help="SQLite DB path"
    )
    approvals_show_parser.set_defaults(func=cmd_approvals_show)
    approvals_approve_parser = approvals_subparsers.add_parser(
        "approve", help="Approve one request"
    )
    approvals_approve_parser.add_argument("approval_id", help="Approval ID")
    approvals_approve_parser.add_argument(
        "--db-path", default=_default_db_path(), help="SQLite DB path"
    )
    approvals_approve_parser.add_argument(
        "--rules-path", default=_default_rules_path(), help="Rules path"
    )
    approvals_approve_parser.add_argument("--reason", default="", help="Approval reason")
    approvals_approve_parser.set_defaults(func=cmd_approvals_resolve, decision="approved")
    approvals_reject_parser = approvals_subparsers.add_parser("reject", help="Reject one request")
    approvals_reject_parser.add_argument("approval_id", help="Approval ID")
    approvals_reject_parser.add_argument(
        "--db-path", default=_default_db_path(), help="SQLite DB path"
    )
    approvals_reject_parser.add_argument(
        "--rules-path", default=_default_rules_path(), help="Rules path"
    )
    approvals_reject_parser.add_argument("--reason", default="", help="Rejection reason")
    approvals_reject_parser.set_defaults(func=cmd_approvals_resolve, decision="rejected")
    approvals_watch_parser = approvals_subparsers.add_parser("watch", help="Watch approval changes")
    approvals_watch_parser.add_argument("--db-path", default=_default_db_path(), help="SQLite DB path")
    approvals_watch_parser.add_argument("--interval", type=float, default=2.0, help="Polling interval seconds")
    approvals_watch_parser.add_argument("--timeout", type=float, default=None, help="Stop after N seconds")
    approvals_watch_parser.add_argument("--limit", type=int, default=50, help="Max approvals per poll")
    approvals_watch_parser.set_defaults(func=cmd_approvals_watch)

    sessions_parser = subparsers.add_parser("sessions", help="Session operations")
    sessions_subparsers = sessions_parser.add_subparsers(dest="sessions_command", required=True)
    sessions_list_parser = sessions_subparsers.add_parser("list", help="List sessions")
    sessions_list_parser.add_argument("--db-path", default=_default_db_path(), help="SQLite DB path")
    sessions_list_parser.add_argument("--limit", type=int, default=100, help="Max sessions")
    sessions_list_parser.set_defaults(func=cmd_sessions_list)
    sessions_show_parser = sessions_subparsers.add_parser("show", help="Show one session timeline")
    sessions_show_parser.add_argument("session_id", help="Session ID")
    sessions_show_parser.add_argument("--db-path", default=_default_db_path(), help="SQLite DB path")
    sessions_show_parser.add_argument("--limit", type=int, default=200, help="Max events")
    sessions_show_parser.set_defaults(func=cmd_sessions_show)
    sessions_export_parser = sessions_subparsers.add_parser("export", help="Export one session")
    sessions_export_parser.add_argument("session_id", help="Session ID")
    sessions_export_parser.add_argument("--format", choices=["md", "json"], default="md", help="Export format")
    sessions_export_parser.add_argument("--out", required=True, help="Output path")
    sessions_export_parser.add_argument("--db-path", default=_default_db_path(), help="SQLite DB path")
    sessions_export_parser.add_argument("--limit", type=int, default=500, help="Max events")
    sessions_export_parser.set_defaults(func=cmd_sessions_export)
    sessions_resume_parser = sessions_subparsers.add_parser("resume", help="Resume one session")
    sessions_resume_parser.add_argument("session_id", help="Session ID")
    sessions_resume_parser.add_argument("--message", default=None, help="Optional message to continue")
    sessions_resume_parser.add_argument("--agent-id", default="semibot", help="Agent ID")
    sessions_resume_parser.add_argument("--model", default=None, help="Model override")
    sessions_resume_parser.add_argument("--system-prompt", default=None, help="System prompt override")
    sessions_resume_parser.add_argument(
        "--server-url",
        default=str(os.getenv("SEMIBOT_RUNTIME_URL", "http://127.0.0.1:8765")),
        help="Runtime service base URL",
    )
    sessions_resume_parser.set_defaults(func=cmd_sessions_resume)

    return parser


def main() -> None:
    global COLOR_ENABLED, OUTPUT_FORMAT
    parser = build_parser()
    args = parser.parse_args()
    OUTPUT_FORMAT = "json" if getattr(args, "json", False) else getattr(args, "output", "table")
    COLOR_ENABLED = not bool(getattr(args, "no_color", False) or os.getenv("NO_COLOR"))
    setup_logging(level=str(getattr(args, "log_level", "CRITICAL")), json_format=False)
    _bootstrap_from_args(args)
    exit_code = args.func(args)
    raise SystemExit(exit_code)


if __name__ == "__main__":
    main()
