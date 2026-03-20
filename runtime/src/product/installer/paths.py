from __future__ import annotations

from dataclasses import dataclass
import json
from pathlib import Path
from typing import Any

from src.bootstrap import semibot_home


@dataclass(frozen=True)
class InstallLayout:
    home: Path
    releases_dir: Path
    active_link: Path
    current_release: Path
    workspace_release: Path
    runtime_release: Path
    api_release: Path
    web_release: Path

    @classmethod
    def discover(cls, home: Path | None = None, version: str = "current") -> "InstallLayout":
        base_home = home.expanduser() if home else semibot_home().expanduser()
        releases_dir = base_home / "releases"
        release_root = releases_dir / version
        workspace_release = release_root / "workspace"
        return cls(
            home=base_home,
            releases_dir=releases_dir,
            active_link=releases_dir / "current",
            current_release=release_root,
            workspace_release=workspace_release,
            runtime_release=workspace_release / "runtime",
            api_release=workspace_release / "apps" / "api",
            web_release=workspace_release / "apps" / "web",
        )

    def active_release_version(self) -> str | None:
        try:
            if self.active_link.is_symlink():
                target = self.active_link.resolve()
                return target.name
        except OSError:
            return None
        if self.current_release.exists():
            return self.current_release.name
        return None

    def release_payload(self) -> dict[str, object]:
        return {
            "releases_dir": str(self.releases_dir),
            "active_link": str(self.active_link),
            "current_release": str(self.current_release),
            "workspace_release": str(self.workspace_release),
            "runtime_release": str(self.runtime_release),
            "api_release": str(self.api_release),
            "web_release": str(self.web_release),
            "active_version": self.active_release_version(),
            "workspace_exists": self.workspace_release.exists(),
            "runtime_exists": self.runtime_release.exists(),
            "api_exists": self.api_release.exists(),
            "web_exists": self.web_release.exists(),
        }

    def installed_workspace_root(self) -> Path | None:
        if self.workspace_release.exists():
            return self.workspace_release
        return None

    def manifest_payload(self) -> dict[str, Any] | None:
        manifest_file = self.current_release / "manifest.json"
        if not manifest_file.exists():
            return None
        try:
            return json.loads(manifest_file.read_text(encoding="utf-8"))
        except Exception:
            return None

    def version_layout(self, version: str) -> "InstallLayout":
        return self.discover(self.home, version=version)

    def installed_versions(self) -> list[dict[str, Any]]:
        versions: list[dict[str, Any]] = []
        if not self.releases_dir.exists():
            return versions
        active_version = self.active_release_version()
        for child in sorted(self.releases_dir.iterdir()):
            if child.name == "current" or child.name.startswith(".") or not child.is_dir():
                continue
            manifest_file = child / "manifest.json"
            build_report_file = child / "build-report.json"
            manifest: dict[str, Any] | None = None
            build_report: dict[str, Any] | None = None
            try:
                if manifest_file.exists():
                    manifest = json.loads(manifest_file.read_text(encoding="utf-8"))
            except Exception:
                manifest = None
            try:
                if build_report_file.exists():
                    build_report = json.loads(build_report_file.read_text(encoding="utf-8"))
            except Exception:
                build_report = None
            versions.append(
                {
                    "version": child.name,
                    "path": str(child),
                    "active": child.name == active_version,
                    "workspace_exists": (child / "workspace").exists(),
                    "manifest_exists": manifest_file.exists(),
                    "build_report_exists": build_report_file.exists(),
                    "build_ok": bool((build_report or {}).get("ok")),
                    "git_commit": (manifest or {}).get("git_commit"),
                    "built_at": (manifest or {}).get("built_at"),
                }
            )
        return versions

    def switch_active_version(self, version: str) -> dict[str, Any]:
        target = self.releases_dir / version
        if not target.exists() or not target.is_dir():
            raise FileNotFoundError(f"installed release not found: {version}")
        if not (target / "workspace").exists():
            raise FileNotFoundError(f"installed release missing workspace: {target / 'workspace'}")
        previous = self.active_release_version()
        self.releases_dir.mkdir(parents=True, exist_ok=True)
        tmp_link = self.releases_dir / f".current.{version}.tmp"
        tmp_link.unlink(missing_ok=True)
        tmp_link.symlink_to(version)
        tmp_link.replace(self.active_link)
        return {
            "previous_version": previous,
            "active_version": version,
            "active_link": str(self.active_link),
            "target_release": str(target),
        }
