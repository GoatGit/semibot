"""Tests for runtime bootstrap helpers."""

from __future__ import annotations

from pathlib import Path

from src.bootstrap import ensure_runtime_home


def test_ensure_runtime_home_creates_layout(tmp_path: Path, monkeypatch) -> None:
    home = tmp_path / ".semibot"
    monkeypatch.setenv("SEMIBOT_HOME", str(home))

    summary = ensure_runtime_home()

    assert Path(summary["home"]).exists()
    assert Path(summary["db_path"]).exists()
    assert Path(summary["rules_path"]).exists()
    assert Path(summary["skills_path"]).exists()
    assert Path(summary["config_path"]).exists()
    assert Path(summary["default_rule_file"]).exists()
