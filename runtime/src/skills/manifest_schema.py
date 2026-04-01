"""Central manifest/index schema helpers for skill metadata."""

from __future__ import annotations

from typing import Any, TypedDict


class SkillResources(TypedDict, total=False):
    has_skill_md: bool
    has_references: bool
    has_templates: bool
    script_files: list[str]


class SkillRequires(TypedDict, total=False):
    binaries: list[str]
    env_vars: list[str]
    python: list[str]


class SkillManifestRecord(TypedDict, total=False):
    schema_version: int
    id: str
    skill_id: str
    name: str
    aliases: list[str]
    description: str
    when_to_use: str
    argument_hint: str
    argument_names: list[str]
    version: str
    source: str
    loaded_from: str
    installed_path: str
    installed_realpath: str
    enabled: bool
    status: str
    user_invocable: bool
    disable_model_invocation: bool
    paths: list[str]
    allowed_tools: list[str]
    execution_context: str | None
    agent: str | None
    effort: str | None
    model: str | None
    hooks: dict[str, Any]
    shell: dict[str, Any]
    requires: SkillRequires
    resources: SkillResources
    script_files: list[str]
    has_skill_md: bool
    has_references: bool
    has_templates: bool
    content_hash: str
    hash: str
    mtime: int
    created_at: str
    updated_at: str
