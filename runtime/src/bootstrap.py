"""Runtime bootstrap helpers for local single-machine Semibot usage."""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any

from src.events.event_store import EventStore
from src.events.rule_loader import ensure_default_rules


def semibot_home() -> Path:
    """Resolve Semibot runtime home directory."""
    raw = os.getenv("SEMIBOT_HOME", "~/.semibot")
    return Path(raw).expanduser()


def default_db_path() -> Path:
    """Default SQLite database path."""
    return semibot_home() / "semibot.db"


def default_rules_path() -> Path:
    """Default rules directory path."""
    return semibot_home() / "rules"


def default_skills_path() -> Path:
    """Default local skills directory path."""
    return semibot_home() / "skills"


def default_config_path() -> Path:
    """Default runtime config TOML path."""
    return semibot_home() / "config.toml"


def _default_config_content() -> str:
    return (
        "# Semibot local runtime config\n"
        "[runtime]\n"
        'db_path = "~/.semibot/semibot.db"\n'
        'rules_path = "~/.semibot/rules"\n'
        'skills_path = "~/.semibot/skills"\n'
        "\n"
        "[llm]\n"
        'default_model = "gpt-4o"\n'
    )


def ensure_runtime_home(
    *,
    db_path: str | None = None,
    rules_path: str | None = None,
) -> dict[str, Any]:
    """
    Ensure local runtime dirs/files exist.

    Returns bootstrap summary for observability/CLI output.
    """
    home = semibot_home()
    home.mkdir(parents=True, exist_ok=True)

    resolved_db_path = Path(db_path).expanduser() if db_path else default_db_path()
    resolved_rules_path = Path(rules_path).expanduser() if rules_path else default_rules_path()
    resolved_skills_path = default_skills_path()
    resolved_config_path = default_config_path()

    resolved_db_path.parent.mkdir(parents=True, exist_ok=True)
    resolved_rules_path.mkdir(parents=True, exist_ok=True)
    resolved_skills_path.mkdir(parents=True, exist_ok=True)

    config_created = False
    if not resolved_config_path.exists():
        resolved_config_path.write_text(_default_config_content(), encoding="utf-8")
        config_created = True

    # Ensure SQLite schema exists and default rules exist.
    EventStore(db_path=str(resolved_db_path))
    default_rule_file = ensure_default_rules(resolved_rules_path)

    return {
        "home": str(home),
        "db_path": str(resolved_db_path),
        "rules_path": str(resolved_rules_path),
        "skills_path": str(resolved_skills_path),
        "config_path": str(resolved_config_path),
        "default_rule_file": str(default_rule_file),
        "config_created": config_created,
    }
