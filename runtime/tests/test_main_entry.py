"""Tests for main runtime entrypoint behavior."""

from __future__ import annotations


def test_src_main_forwards_to_cli(monkeypatch) -> None:
    called = {"ok": False}

    def _fake_cli_main() -> None:
        called["ok"] = True

    monkeypatch.setattr("src.cli.main", _fake_cli_main)

    from src.main import main

    main()
    assert called["ok"] is True
