from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path


@dataclass(frozen=True)
class ProductPaths:
    home: Path
    config_dir: Path
    data_dir: Path
    logs_dir: Path
    run_dir: Path
    releases_dir: Path


@dataclass(frozen=True)
class ProductLLMConfig:
    default_model: str | None = None
    openai_api_key: str | None = None
    anthropic_api_key: str | None = None


@dataclass(frozen=True)
class ProductRuntimeConfig:
    host: str = "127.0.0.1"
    port: int = 8765
    db_path: str = ""
    rules_path: str = ""
    heartbeat_interval: float | None = None
    cron_jobs_json: str | None = None


@dataclass(frozen=True)
class ProductServicePorts:
    api: int = 3001
    web: int = 3000


@dataclass(frozen=True)
class ProductUpdateConfig:
    manifest_url: str | None = "https://releases.semibot.ai/stable/latest.json"


@dataclass(frozen=True)
class ProductConfig:
    paths: ProductPaths
    runtime: ProductRuntimeConfig = field(default_factory=ProductRuntimeConfig)
    ports: ProductServicePorts = field(default_factory=ProductServicePorts)
    llm: ProductLLMConfig = field(default_factory=ProductLLMConfig)
    updates: ProductUpdateConfig = field(default_factory=ProductUpdateConfig)
    feature_flags: dict[str, bool] = field(
        default_factory=lambda: {
            "sqlite_default": True,
            "postgres_enabled": False,
            "redis_enabled": False,
            "docker_sandbox_enabled": False,
        }
    )
