from __future__ import annotations

from dataclasses import asdict
from datetime import UTC, datetime
import os
from pathlib import Path
from typing import Any

from src.bootstrap import (
    default_db_path as bootstrap_default_db_path,
)
from src.bootstrap import (
    default_rules_path as bootstrap_default_rules_path,
)
from src.bootstrap import semibot_home

from ..installer import InstallLayout
from .schema import ProductConfig, ProductLLMConfig, ProductPaths, ProductRuntimeConfig, ProductServicePorts, ProductUpdateConfig

try:
    import yaml  # type: ignore
except Exception:  # pragma: no cover
    yaml = None


class ProductConfigLoader:
    """Centralizes install-mode paths, config loading, and status snapshots."""

    def __init__(self, home: Path | None = None) -> None:
        base_home = home.expanduser() if home else semibot_home().expanduser()
        self._paths = ProductPaths(
            home=base_home,
            config_dir=base_home / "config",
            data_dir=base_home / "data",
            logs_dir=base_home / "logs",
            run_dir=base_home / "run",
            releases_dir=base_home / "releases",
        )

    @property
    def paths(self) -> ProductPaths:
        return self._paths

    def default_config(self) -> ProductConfig:
        return ProductConfig(
            paths=self._paths,
            runtime=ProductRuntimeConfig(
                host="127.0.0.1",
                port=8765,
                db_path=bootstrap_default_db_path(),
                rules_path=bootstrap_default_rules_path(),
            ),
            ports=ProductServicePorts(api=3001, web=3000),
            updates=ProductUpdateConfig(),
        )

    def as_dict(self) -> dict[str, Any]:
        payload = asdict(self.load())
        payload["paths"] = {key: str(value) for key, value in payload["paths"].items()}
        return payload

    def config_file(self) -> Path:
        return self._paths.config_dir / "config.yaml"

    def env_file(self) -> Path:
        return self._paths.home / "env" / "default.env"

    def state_snapshot_file(self) -> Path:
        return self._paths.run_dir / "service-status.json"

    def load(self, overrides: dict[str, Any] | None = None) -> ProductConfig:
        defaults = self.default_config()
        file_config = self._read_config_file()
        file_env = self._read_env_file(self.env_file())
        process_env = dict(os.environ)
        merged = {**process_env, **file_env}
        cli = {key: value for key, value in (overrides or {}).items() if value is not None}

        runtime_host = self._resolve_value(
            cli.get("runtime_host"),
            self._nested_get(file_config, "runtime", "host"),
            merged.get("SEMIBOT_RUNTIME_HOST"),
            defaults.runtime.host,
        )
        runtime_port = int(
            self._resolve_value(
                cli.get("runtime_port"),
                self._nested_get(file_config, "runtime", "port"),
                merged.get("SEMIBOT_RUNTIME_PORT"),
                defaults.runtime.port,
            )
        )
        api_port = int(
            self._resolve_value(
                cli.get("api_port"),
                self._nested_get(file_config, "api", "port"),
                merged.get("SEMIBOT_API_PORT"),
                defaults.ports.api,
            )
        )
        web_port = int(
            self._resolve_value(
                cli.get("web_port"),
                self._nested_get(file_config, "web", "port"),
                merged.get("SEMIBOT_WEB_PORT"),
                merged.get("PORT"),
                defaults.ports.web,
            )
        )
        default_model = self._resolve_value(
            cli.get("default_model"),
            self._nested_get(file_config, "llm", "default_model"),
            merged.get("DEFAULT_LLM_MODEL"),
            defaults.llm.default_model,
        )
        openai_api_key = self._resolve_value(
            cli.get("openai_api_key"),
            self._nested_get(file_config, "llm", "openai_api_key"),
            merged.get("OPENAI_API_KEY"),
            defaults.llm.openai_api_key,
        )
        anthropic_api_key = self._resolve_value(
            cli.get("anthropic_api_key"),
            self._nested_get(file_config, "llm", "anthropic_api_key"),
            merged.get("ANTHROPIC_API_KEY"),
            defaults.llm.anthropic_api_key,
        )
        runtime_db_path = str(
            self._resolve_value(
                cli.get("runtime_db_path"),
                self._nested_get(file_config, "runtime", "db_path"),
                merged.get("SEMIBOT_RUNTIME_DB_PATH"),
                defaults.runtime.db_path,
            )
        )
        runtime_rules_path = str(
            self._resolve_value(
                cli.get("runtime_rules_path"),
                self._nested_get(file_config, "runtime", "rules_path"),
                merged.get("SEMIBOT_RUNTIME_RULES_PATH"),
                defaults.runtime.rules_path,
            )
        )
        update_manifest_url = self._resolve_value(
            cli.get("update_manifest_url"),
            self._nested_get(file_config, "updates", "manifest_url"),
            merged.get("SEMIBOT_UPDATE_MANIFEST_URL"),
            defaults.updates.manifest_url,
        )

        feature_flags = dict(defaults.feature_flags)
        raw_feature_flags = self._nested_get(file_config, "feature_flags")
        if isinstance(raw_feature_flags, dict):
            for key, value in raw_feature_flags.items():
                feature_flags[str(key)] = bool(value)
        feature_flags.update({key: bool(value) for key, value in cli.get("feature_flags", {}).items()})

        return ProductConfig(
            paths=self._paths,
            runtime=ProductRuntimeConfig(
                host=str(runtime_host),
                port=runtime_port,
                db_path=runtime_db_path,
                rules_path=runtime_rules_path,
                heartbeat_interval=self._maybe_float(cli.get("runtime_heartbeat_interval")),
                cron_jobs_json=cli.get("runtime_cron_jobs_json"),
            ),
            ports=ProductServicePorts(api=api_port, web=web_port),
            llm=ProductLLMConfig(
                default_model=str(default_model) if default_model else None,
                openai_api_key=str(openai_api_key) if openai_api_key else None,
                anthropic_api_key=str(anthropic_api_key) if anthropic_api_key else None,
            ),
            updates=ProductUpdateConfig(
                manifest_url=str(update_manifest_url) if update_manifest_url else None,
            ),
            feature_flags=feature_flags,
        )

    def ensure_layout(
        self,
        *,
        runtime_host: str = "127.0.0.1",
        runtime_port: int = 8765,
        api_port: int = 3001,
        web_port: int = 3000,
        default_model: str | None = None,
        openai_api_key: str | None = None,
        anthropic_api_key: str | None = None,
        update_manifest_url: str | None = None,
        force: bool = False,
    ) -> dict[str, Any]:
        for path in (
            self._paths.home,
            self._paths.config_dir,
            self._paths.data_dir,
            self._paths.logs_dir,
            self._paths.run_dir,
            self._paths.releases_dir,
        ):
            path.mkdir(parents=True, exist_ok=True)

        config_file = self.config_file()
        env_file = self.env_file()
        env_file.parent.mkdir(parents=True, exist_ok=True)

        migration = self.discover_legacy_config()
        migrated_values = migration.get("values") if isinstance(migration.get("values"), dict) else {}
        if not default_model:
            raw_model = migrated_values.get("DEFAULT_LLM_MODEL")
            if isinstance(raw_model, str) and raw_model.strip():
                default_model = raw_model.strip()
        if not openai_api_key:
            raw_openai = migrated_values.get("OPENAI_API_KEY")
            if isinstance(raw_openai, str) and raw_openai.strip():
                openai_api_key = raw_openai.strip()
        if not anthropic_api_key:
            raw_anthropic = migrated_values.get("ANTHROPIC_API_KEY")
            if isinstance(raw_anthropic, str) and raw_anthropic.strip():
                anthropic_api_key = raw_anthropic.strip()

        config_content_lines = [
            "runtime:",
            f"  host: {runtime_host}",
            f"  port: {runtime_port}",
            f"  db_path: {bootstrap_default_db_path()}",
            f"  rules_path: {bootstrap_default_rules_path()}",
            "api:",
            f"  port: {api_port}",
            "web:",
            f"  port: {web_port}",
        ]
        if default_model:
            config_content_lines.extend(["llm:", f"  default_model: {default_model}"])
        if update_manifest_url:
            config_content_lines.extend(["updates:", f"  manifest_url: {update_manifest_url}"])
        config_content = "\n".join(config_content_lines) + "\n"

        env_lines = [
            "# Semibot install-mode environment",
            f'OPENAI_API_KEY="{openai_api_key}"' if openai_api_key else "# OPENAI_API_KEY=",
            f'ANTHROPIC_API_KEY="{anthropic_api_key}"' if anthropic_api_key else "# ANTHROPIC_API_KEY=",
            f'SEMIBOT_UPDATE_MANIFEST_URL="{update_manifest_url}"' if update_manifest_url else "# SEMIBOT_UPDATE_MANIFEST_URL=",
        ]
        if default_model:
            env_lines.append(f'DEFAULT_LLM_MODEL="{default_model}"')
        env_content = "\n".join(env_lines) + "\n"

        created_files: list[str] = []
        updated_files: list[str] = []
        if force or not config_file.exists():
            config_file.write_text(config_content, encoding="utf-8")
            created_files.append(str(config_file))
        elif config_file.read_text(encoding="utf-8") != config_content:
            updated_files.append(str(config_file))
        if force or not env_file.exists():
            env_file.write_text(env_content, encoding="utf-8")
            self._set_env_file_permissions(env_file)
            created_files.append(str(env_file))
        elif self._merge_env_file(
            env_file,
            {
                "OPENAI_API_KEY": openai_api_key,
                "ANTHROPIC_API_KEY": anthropic_api_key,
                "DEFAULT_LLM_MODEL": default_model,
                "SEMIBOT_UPDATE_MANIFEST_URL": update_manifest_url,
            },
        ):
            updated_files.append(str(env_file))
        if env_file.exists():
            self._set_env_file_permissions(env_file)

        return {
            "paths": {
                "home": str(self._paths.home),
                "config_dir": str(self._paths.config_dir),
                "data_dir": str(self._paths.data_dir),
                "logs_dir": str(self._paths.logs_dir),
                "run_dir": str(self._paths.run_dir),
                "releases_dir": str(self._paths.releases_dir),
            },
            "created_files": created_files,
            "updated_files": updated_files,
            "config_file": str(config_file),
            "env_file": str(env_file),
            "migration": {
                "source": migration.get("source"),
                "imported_keys": migration.get("imported_keys"),
                "values_preview": migration.get("values_preview"),
            },
        }

    def doctor_checks(self) -> dict[str, bool]:
        return {
            "home_exists": self._paths.home.exists(),
            "config_dir_exists": self._paths.config_dir.exists(),
            "data_dir_exists": self._paths.data_dir.exists(),
            "logs_dir_exists": self._paths.logs_dir.exists(),
            "run_dir_exists": self._paths.run_dir.exists(),
            "releases_dir_exists": self._paths.releases_dir.exists(),
            "config_file_exists": (self._paths.config_dir / "config.yaml").exists(),
            "env_file_exists": (self._paths.home / "env" / "default.env").exists(),
            "state_snapshot_exists": self.state_snapshot_file().exists(),
        }

    def release_checks(self) -> dict[str, bool]:
        layout = InstallLayout.discover(self._paths.home)
        manifest_file = layout.current_release / "manifest.json"
        build_report_file = layout.current_release / "build-report.json"
        return {
            "releases_dir_exists": layout.releases_dir.exists(),
            "active_release_link_exists": layout.active_link.exists(),
            "release_manifest_exists": manifest_file.exists(),
            "release_build_report_exists": build_report_file.exists(),
            "workspace_release_exists": layout.workspace_release.exists(),
            "runtime_release_exists": layout.runtime_release.exists(),
            "api_release_exists": layout.api_release.exists(),
            "web_release_exists": layout.web_release.exists(),
        }

    def active_release_payload(self) -> dict[str, Any]:
        return InstallLayout.discover(self._paths.home).release_payload()

    def read_state_snapshot(self) -> dict[str, Any] | None:
        path = self.state_snapshot_file()
        if not path.exists():
            return None
        try:
            import json

            payload = json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            return None
        return payload if isinstance(payload, dict) else None

    def write_state_snapshot(self, *, action: str, payload: dict[str, Any]) -> Path | None:
        snapshot = {
            "action": action,
            "updated_at": datetime.now(UTC).isoformat(),
            "payload": payload,
        }
        import json

        path = self.state_snapshot_file()
        try:
            self._paths.run_dir.mkdir(parents=True, exist_ok=True)
            path.write_text(json.dumps(snapshot, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        except OSError:
            return None
        return path

    def writable_checks(self) -> dict[str, bool]:
        checks: dict[str, bool] = {}
        for key, path in {
            "home_writable": self._paths.home,
            "config_dir_writable": self._paths.config_dir,
            "data_dir_writable": self._paths.data_dir,
            "logs_dir_writable": self._paths.logs_dir,
            "run_dir_writable": self._paths.run_dir,
            "releases_dir_writable": self._paths.releases_dir,
        }.items():
            try:
                checks[key] = path.exists() and os.access(path, os.W_OK)
            except OSError:
                checks[key] = False
        return checks

    def _set_env_file_permissions(self, env_file: Path) -> None:
        try:
            os.chmod(env_file, 0o600)
        except OSError:
            pass

    def _parse_env_assignment_key(self, line: str) -> str | None:
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            return None
        if stripped.startswith("export "):
            stripped = stripped[len("export ") :]
        key, sep, _raw_value = stripped.partition("=")
        if not sep:
            return None
        key = key.strip()
        return key or None

    def _merge_env_file(self, env_file: Path, updates: dict[str, str | None]) -> bool:
        try:
            existing_lines = env_file.read_text(encoding="utf-8").splitlines()
        except OSError:
            return False
        kept_lines: list[str] = []
        changed = False
        for line in existing_lines:
            existing_key = self._parse_env_assignment_key(line)
            if existing_key in updates:
                changed = True
                continue
            kept_lines.append(line)
        for key, value in updates.items():
            if value:
                escaped = value.replace("\\", "\\\\").replace('"', '\\"')
                kept_lines.append(f'{key}="{escaped}"')
                changed = True
        rendered = "\n".join(kept_lines).rstrip() + "\n"
        if changed:
            env_file.write_text(rendered, encoding="utf-8")
            self._set_env_file_permissions(env_file)
        return changed

    def discover_legacy_config(self, source_root: Path | None = None) -> dict[str, Any]:
        root = source_root or Path(__file__).resolve().parents[4]
        candidates = [root / ".env.local", root / ".env"]
        for candidate in candidates:
            parsed = self._read_env_file(candidate)
            values = {
                key: value
                for key, value in parsed.items()
                if key in {"OPENAI_API_KEY", "ANTHROPIC_API_KEY", "DEFAULT_LLM_MODEL"}
                and str(value).strip()
            }
            if values:
                return {
                    "source": str(candidate),
                    "imported_keys": sorted(values.keys()),
                    "values": values,
                    "values_preview": {
                        key: ("***" if "KEY" in key else value)
                        for key, value in values.items()
                    },
                }
        return {"source": None, "imported_keys": [], "values": {}, "values_preview": {}}

    def _read_config_file(self) -> dict[str, Any]:
        path = self.config_file()
        if not path.exists() or yaml is None:
            return {}
        try:
            raw = yaml.safe_load(path.read_text(encoding="utf-8"))
        except Exception:
            return {}
        return raw if isinstance(raw, dict) else {}

    def _read_env_file(self, path: Path) -> dict[str, str]:
        if not path.exists():
            return {}
        values: dict[str, str] = {}
        try:
            lines = path.read_text(encoding="utf-8").splitlines()
        except OSError:
            return {}
        for line in lines:
            stripped = line.strip()
            if not stripped or stripped.startswith("#"):
                continue
            if stripped.startswith("export "):
                stripped = stripped[len("export ") :]
            key, sep, raw_value = stripped.partition("=")
            if not sep:
                continue
            key = key.strip()
            value = raw_value.strip().strip('"').strip("'")
            if key:
                values[key] = value
        return values

    def _resolve_value(self, *values: Any) -> Any:
        for value in values:
            if value is None:
                continue
            if isinstance(value, str) and not value.strip():
                continue
            return value
        return None

    def _nested_get(self, data: dict[str, Any], *path: str) -> Any:
        current: Any = data
        for part in path:
            if not isinstance(current, dict):
                return None
            current = current.get(part)
        return current

    def _maybe_float(self, value: Any) -> float | None:
        if value is None or value == "":
            return None
        try:
            return float(value)
        except (TypeError, ValueError):
            return None
