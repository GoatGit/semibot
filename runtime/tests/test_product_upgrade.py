from __future__ import annotations

import json
from pathlib import Path

import pytest

from src.product.commands.bootstrap import _validate_remote_url, build_product_upgrade_payload
from src.product.config import ProductConfigLoader


def test_build_product_upgrade_payload_installs_release_without_workspace_root_install_script(
    monkeypatch,
    tmp_path: Path,
) -> None:
    home = tmp_path / ".semibot"
    monkeypatch.setenv("SEMIBOT_HOME", str(home))

    loader = ProductConfigLoader()
    loader.ensure_layout(force=True)

    release_root = tmp_path / "release"
    workspace_root = release_root / "workspace"
    runtime_root = workspace_root / "runtime"
    runtime_scripts = runtime_root / "scripts"
    runtime_scripts.mkdir(parents=True, exist_ok=True)
    (workspace_root / "scripts").mkdir(parents=True, exist_ok=True)
    (runtime_root / "src").mkdir(parents=True, exist_ok=True)
    (release_root / "manifest.json").write_text(
        json.dumps({"version": "2026.03.21.22"}),
        encoding="utf-8",
    )
    (release_root / "build-report.json").write_text(
        json.dumps(
            {
                "ok": True,
                "artifact_checks": {
                    "workspace": True,
                    "runtime": True,
                },
            }
        ),
        encoding="utf-8",
    )
    (runtime_scripts / "install.sh").write_text("#!/usr/bin/env bash\nexit 0\n", encoding="utf-8")
    (workspace_root / "scripts" / "install.sh").unlink(missing_ok=True)

    calls: list[list[str]] = []

    def _fake_run(cmd: list[str], **kwargs: object):
        calls.append(cmd)
        installed_runtime_root = home / "releases" / "2026.03.21.22" / "workspace" / "runtime"
        assert cmd == ["bash", str(installed_runtime_root / "scripts" / "install.sh")]
        assert kwargs["cwd"] == str(installed_runtime_root)
        env = kwargs["env"]
        assert isinstance(env, dict)
        assert env["SEMIBOT_HOME"] == str(home)
        assert env["SEMIBOT_RELEASE_VERSION"] == "2026.03.21.22"

        class _Result:
            returncode = 0
            stdout = "ok\n"
            stderr = ""

        return _Result()

    monkeypatch.setattr("src.product.commands.bootstrap.subprocess.run", _fake_run)

    payload = build_product_upgrade_payload(
        release_dir=str(release_root),
        release_url=None,
        manifest_url=None,
        sha256=None,
        version=None,
    )

    assert payload["ok"] is True
    assert payload["action"] == "install"
    assert payload["active_release"]["active_version"] == "2026.03.21.22"
    assert (home / "releases" / "current").resolve().name == "2026.03.21.22"
    assert calls == [["bash", str(home / "releases" / "2026.03.21.22" / "workspace" / "runtime" / "scripts" / "install.sh")]]


def test_validate_remote_url_requires_https_and_public_host() -> None:
    assert _validate_remote_url("https://releases.semibot.ai/stable/latest.json", field_name="manifest URL").startswith(
        "https://releases.semibot.ai/"
    )
    with pytest.raises(RuntimeError, match="must use HTTPS"):
        _validate_remote_url("http://releases.semibot.ai/stable/latest.json", field_name="manifest URL")
    with pytest.raises(RuntimeError, match="host is not allowed"):
        _validate_remote_url("https://127.0.0.1/stable/latest.json", field_name="manifest URL")


def test_build_product_upgrade_payload_uses_configured_manifest_url_by_default(monkeypatch, tmp_path: Path) -> None:
    home = tmp_path / ".semibot"
    monkeypatch.setenv("SEMIBOT_HOME", str(home))

    loader = ProductConfigLoader()
    loader.ensure_layout(update_manifest_url="https://releases.semibot.ai/stable/latest.json", force=True)

    captured: dict[str, object] = {}

    def _fake_download_release_from_manifest(*, manifest_url: str, sha256: str | None):
        captured["manifest_url"] = manifest_url
        release_root = tmp_path / "release"
        workspace_root = release_root / "workspace" / "runtime" / "scripts"
        workspace_root.mkdir(parents=True, exist_ok=True)
        (release_root / "manifest.json").write_text(json.dumps({"version": "2026.03.22.04"}), encoding="utf-8")
        (release_root / "build-report.json").write_text(
            json.dumps({"ok": True, "artifact_checks": {"workspace": True, "runtime": True}}),
            encoding="utf-8",
        )
        (workspace_root / "install.sh").write_text("#!/usr/bin/env bash\nexit 0\n", encoding="utf-8")
        return release_root, None

    def _fake_install_release_into_home(*, release_root: Path, loader: ProductConfigLoader, install_layout):
        captured["release_root"] = release_root
        return {"stdout_tail": [], "stderr_tail": []}

    monkeypatch.setattr(
        "src.product.commands.bootstrap._download_release_from_manifest",
        _fake_download_release_from_manifest,
    )
    monkeypatch.setattr(
        "src.product.commands.bootstrap._install_release_into_home",
        _fake_install_release_into_home,
    )

    payload = build_product_upgrade_payload(
        release_dir=None,
        release_url=None,
        manifest_url=None,
        sha256=None,
        version=None,
    )

    assert payload["action"] == "manifest-install"
    assert captured["manifest_url"] == "https://releases.semibot.ai/stable/latest.json"


def test_install_release_into_home_preserves_workspace_symlinks(monkeypatch, tmp_path: Path) -> None:
    home = tmp_path / ".semibot"
    monkeypatch.setenv("SEMIBOT_HOME", str(home))

    loader = ProductConfigLoader()
    loader.ensure_layout(force=True)

    release_root = tmp_path / "release"
    workspace_root = release_root / "workspace"
    runtime_root = workspace_root / "runtime"
    runtime_scripts = runtime_root / "scripts"
    runtime_scripts.mkdir(parents=True, exist_ok=True)
    (workspace_root / "node_modules").mkdir(parents=True, exist_ok=True)
    target_dir = workspace_root / "store"
    target_dir.mkdir(parents=True, exist_ok=True)
    symlink_path = workspace_root / "node_modules" / ".pnpm-link"
    symlink_path.symlink_to("../store")
    (release_root / "manifest.json").write_text(
        json.dumps({"version": "2026.03.22.06"}),
        encoding="utf-8",
    )
    (release_root / "build-report.json").write_text(
        json.dumps({"ok": True, "artifact_checks": {"workspace": True, "runtime": True}}),
        encoding="utf-8",
    )
    (runtime_scripts / "install.sh").write_text("#!/usr/bin/env bash\nexit 0\n", encoding="utf-8")

    def _fake_run(cmd: list[str], **kwargs: object):
        class _Result:
            returncode = 0
            stdout = ""
            stderr = ""

        return _Result()

    monkeypatch.setattr("src.product.commands.bootstrap.subprocess.run", _fake_run)

    payload = build_product_upgrade_payload(
        release_dir=str(release_root),
        release_url=None,
        manifest_url=None,
        sha256=None,
        version=None,
    )

    assert payload["ok"] is True
    installed_link = home / "releases" / "2026.03.22.06" / "workspace" / "node_modules" / ".pnpm-link"
    assert installed_link.is_symlink()
