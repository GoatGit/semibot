"""Skills metadata index manager for installed skills."""

from __future__ import annotations

import hashlib
import json
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import yaml

from src.utils.logging import get_logger

logger = get_logger(__name__)

INDEX_FILENAME = ".index.json"
STATE_FILENAME = ".state.json"
INDEX_SCHEMA_VERSION = 3
_DEFAULT_REQUIRES = {"binaries": [], "env_vars": [], "python": []}
_ALLOWED_EFFORTS = {"low", "medium", "high", "xhigh", "inherit"}
_ALLOWED_EXECUTION_CONTEXTS = {"inline", "fork"}


def _iso_now() -> str:
    return datetime.now(UTC).isoformat()


def _read_json_file(path: Path) -> dict[str, Any] | None:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None
    return payload if isinstance(payload, dict) else None


def _read_skill_md_text(skill_dir: Path) -> str:
    skill_md = skill_dir / "SKILL.md"
    if not skill_md.exists() or not skill_md.is_file():
        return ""
    return skill_md.read_text(encoding="utf-8", errors="ignore")


def _read_frontmatter(skill_dir: Path) -> dict[str, Any]:
    raw = _read_skill_md_text(skill_dir)
    if not raw:
        return {}
    lines = raw.splitlines()
    if not lines or lines[0].strip() != "---":
        return {}
    end_idx = None
    for idx in range(1, len(lines)):
        if lines[idx].strip() == "---":
            end_idx = idx
            break
    if end_idx is None:
        return {}
    frontmatter_raw = "\n".join(lines[1:end_idx]).strip()
    if not frontmatter_raw:
        return {}
    try:
        payload = yaml.safe_load(frontmatter_raw)
    except Exception:
        return {}
    return payload if isinstance(payload, dict) else {}


def _skill_body_start_index(lines: list[str]) -> int:
    if not lines or lines[0].strip() != "---":
        return 0
    for idx in range(1, len(lines)):
        if lines[idx].strip() == "---":
            return idx + 1
    return 0


def _read_description(skill_dir: Path, fallback_name: str) -> str:
    skill_md = skill_dir / "SKILL.md"
    if not skill_md.exists():
        return f"Installed skill: {fallback_name}"
    lines = skill_md.read_text(encoding="utf-8", errors="ignore").splitlines()
    frontmatter = _read_frontmatter(skill_dir)
    if isinstance(frontmatter.get("description"), str) and str(frontmatter["description"]).strip():
        return str(frontmatter["description"]).strip()
    body_start = _skill_body_start_index(lines)
    in_code_block = False
    for raw in lines[body_start:]:
        line = raw.strip()
        if not line:
            continue
        if line.startswith("```"):
            in_code_block = not in_code_block
            continue
        if in_code_block:
            continue
        if line in {"---", "***", "___"}:
            continue
        if line.startswith("#"):
            line = line.lstrip("#").strip()
        if line:
            return line
    return f"Installed skill: {fallback_name}"


def _read_manifest(skill_dir: Path) -> dict[str, Any]:
    for candidate in ("skill.json", "semibot.skill.json"):
        payload = _read_json_file(skill_dir / candidate)
        if payload:
            return payload
    return {}


def _as_string_list(value: Any) -> list[str]:
    if isinstance(value, str):
        parts = [
            item.strip()
            for item in value.replace("\n", ",").split(",")
        ]
        return [item for item in parts if item]
    if isinstance(value, list):
        values: list[str] = []
        for item in value:
            if not isinstance(item, str):
                continue
            text = item.strip()
            if text:
                values.append(text)
        return values
    return []


def _dedupe_str_list(items: list[str]) -> list[str]:
    seen: set[str] = set()
    values: list[str] = []
    for item in items:
        text = str(item or "").strip()
        if not text or text in seen:
            continue
        seen.add(text)
        values.append(text)
    return values


def _get_frontmatter_or_manifest(frontmatter: dict[str, Any], manifest: dict[str, Any], *keys: str) -> Any:
    for key in keys:
        if key in frontmatter and frontmatter.get(key) is not None:
            return frontmatter.get(key)
    for key in keys:
        if key in manifest and manifest.get(key) is not None:
            return manifest.get(key)
    return None


def _normalize_aliases(value: Any) -> list[str]:
    return _dedupe_str_list(_as_string_list(value))


def _normalize_paths(value: Any) -> list[str]:
    values = _dedupe_str_list(_as_string_list(value))
    return [item for item in values if item != "**"]


def _normalize_allowed_tools(value: Any) -> list[str]:
    return _dedupe_str_list(_as_string_list(value))


def _normalize_effort(value: Any) -> str | None:
    text = str(value or "").strip().lower()
    return text if text in _ALLOWED_EFFORTS else None


def _normalize_execution_context(value: Any) -> str | None:
    text = str(value or "").strip().lower()
    return text if text in _ALLOWED_EXECUTION_CONTEXTS else None


def _normalize_bool(value: Any, default: bool) -> bool:
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    text = str(value).strip().lower()
    if text in {"1", "true", "yes", "on"}:
        return True
    if text in {"0", "false", "no", "off"}:
        return False
    return default


def _normalize_requires(value: Any) -> dict[str, list[str]]:
    if not isinstance(value, dict):
        return dict(_DEFAULT_REQUIRES)
    return {
        "binaries": _dedupe_str_list(_as_string_list(value.get("binaries"))),
        "env_vars": _dedupe_str_list(_as_string_list(value.get("env_vars"))),
        "python": _dedupe_str_list(_as_string_list(value.get("python"))),
    }


def _scan_script_files(skill_dir: Path) -> list[str]:
    scripts_dir = skill_dir / "scripts"
    if not scripts_dir.exists() or not scripts_dir.is_dir():
        return []
    return sorted(
        str(path.relative_to(skill_dir)).replace("\\", "/")
        for path in scripts_dir.rglob("*")
        if path.is_file()
    )


def _build_resources_summary(skill_dir: Path) -> dict[str, Any]:
    script_files = _scan_script_files(skill_dir)
    return {
        "has_skill_md": (skill_dir / "SKILL.md").exists(),
        "has_references": (skill_dir / "reference").is_dir() or (skill_dir / "references").is_dir(),
        "has_templates": (skill_dir / "templates").is_dir(),
        "script_files": script_files,
    }


def _content_hash(skill_dir: Path) -> str:
    hasher = hashlib.sha256()
    for file in sorted(skill_dir.rglob("*")):
        if not file.is_file():
            continue
        rel = file.relative_to(skill_dir).as_posix()
        if rel in {INDEX_FILENAME, STATE_FILENAME}:
            continue
        hasher.update(rel.encode("utf-8"))
        hasher.update(b"\0")
        hasher.update(str(file.stat().st_size).encode("utf-8"))
        hasher.update(b"\0")
        try:
            hasher.update(file.read_bytes())
        except Exception:
            continue
        hasher.update(b"\0")
    return hasher.hexdigest()


def resolve_skill_dir(candidate: Path) -> Path | None:
    """Resolve to a directory that looks like an installed skill."""
    if not candidate.exists() or candidate.is_file():
        return None
    if (candidate / "SKILL.md").exists():
        return candidate
    direct_scripts = candidate / "scripts"
    if direct_scripts.exists() and direct_scripts.is_dir():
        return candidate
    for child in candidate.iterdir():
        if not child.is_dir():
            continue
        if (child / "SKILL.md").exists():
            return child
        nested_scripts = child / "scripts"
        if nested_scripts.exists() and nested_scripts.is_dir():
            return child
    return None


def resolve_skill_scripts_dir(candidate: Path) -> Path | None:
    """Resolve to a directory that contains at least one file under scripts/."""
    if not candidate.exists() or candidate.is_file():
        return None
    direct_scripts = candidate / "scripts"
    if direct_scripts.exists() and direct_scripts.is_dir():
        for child in direct_scripts.iterdir():
            if child.is_file():
                return candidate
    for child in candidate.iterdir():
        if not child.is_dir():
            continue
        nested_scripts = child / "scripts"
        if not nested_scripts.exists() or not nested_scripts.is_dir():
            continue
        for nested_file in nested_scripts.iterdir():
            if nested_file.is_file():
                return child
    return None


def resolve_skill_md_dir(candidate: Path) -> Path | None:
    """Resolve to a directory that contains SKILL.md."""
    if not candidate.exists() or candidate.is_file():
        return None
    direct = candidate / "SKILL.md"
    if direct.exists():
        return candidate
    for child in candidate.iterdir():
        if not child.is_dir():
            continue
        nested = child / "SKILL.md"
        if nested.exists():
            return child
    return None


class SkillsIndexManager:
    def __init__(self, skills_root: str | Path) -> None:
        self.skills_root = Path(skills_root).expanduser()
        self.skills_root.mkdir(parents=True, exist_ok=True)
        self.index_path = self.skills_root / INDEX_FILENAME

    def read_index(self) -> dict[str, Any]:
        if not self.index_path.exists():
            return {"schema_version": INDEX_SCHEMA_VERSION, "generated_at": _iso_now(), "skills": []}
        payload = _read_json_file(self.index_path)
        if not payload:
            return {"schema_version": INDEX_SCHEMA_VERSION, "generated_at": _iso_now(), "skills": []}
        rows = payload.get("skills")
        if not isinstance(rows, list):
            payload["skills"] = []
        payload["schema_version"] = int(payload.get("schema_version") or 2)
        return payload

    def write_index(self, rows: list[dict[str, Any]]) -> dict[str, Any]:
        payload = {
            "schema_version": INDEX_SCHEMA_VERSION,
            "generated_at": _iso_now(),
            "skills": rows,
        }
        try:
            self.index_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        except PermissionError:
            logger.warning("skills_index_write_denied", extra={"index_path": str(self.index_path)})
        except OSError as exc:
            logger.warning("skills_index_write_failed", extra={"index_path": str(self.index_path), "error": str(exc)})
        return payload

    def list_records(self) -> list[dict[str, Any]]:
        payload = self.read_index()
        rows = payload.get("skills")
        return rows if isinstance(rows, list) else []

    def _build_record(
        self,
        *,
        skill_id: str,
        skill_dir: Path,
        source: str,
        previous: dict[str, Any] | None = None,
        force: bool = False,
    ) -> tuple[dict[str, Any], bool]:
        previous = previous or {}
        now = _iso_now()
        manifest = _read_manifest(skill_dir)
        frontmatter = _read_frontmatter(skill_dir)
        current_hash = _content_hash(skill_dir)
        mtime = int(skill_dir.stat().st_mtime)
        hash_unchanged = str(previous.get("hash") or previous.get("content_hash") or "") == current_hash
        mtime_unchanged = int(previous.get("mtime") or 0) == mtime
        changed = force or not (hash_unchanged and mtime_unchanged)
        resources = _build_resources_summary(skill_dir)
        requires = _normalize_requires(
            _get_frontmatter_or_manifest(frontmatter, manifest, "requires")
        )
        aliases = _normalize_aliases(_get_frontmatter_or_manifest(frontmatter, manifest, "aliases"))
        argument_names = _dedupe_str_list(
            _as_string_list(_get_frontmatter_or_manifest(frontmatter, manifest, "arguments"))
        )
        name = str(
            _get_frontmatter_or_manifest(frontmatter, manifest, "name")
            or previous.get("name")
            or skill_id
        ).strip() or skill_id
        description = str(
            _get_frontmatter_or_manifest(frontmatter, manifest, "description")
            or previous.get("description")
            or _read_description(skill_dir, skill_id)
        ).strip() or _read_description(skill_dir, skill_id)
        version = str(
            _get_frontmatter_or_manifest(frontmatter, manifest, "version")
            or previous.get("version")
            or "0.0.0-local"
        ).strip() or "0.0.0-local"
        source_value = str(source or previous.get("source") or "manual").strip() or "manual"
        installed_realpath = str(skill_dir.resolve())
        when_to_use = str(
            _get_frontmatter_or_manifest(frontmatter, manifest, "when_to_use", "whenToUse")
            or previous.get("when_to_use")
            or ""
        ).strip()
        argument_hint = str(
            _get_frontmatter_or_manifest(frontmatter, manifest, "argument-hint", "argument_hint")
            or previous.get("argument_hint")
            or ""
        ).strip()
        execution_context = (
            _normalize_execution_context(
                _get_frontmatter_or_manifest(frontmatter, manifest, "context", "execution_context")
            )
            or str(previous.get("execution_context") or "").strip()
            or None
        )
        effort = (
            _normalize_effort(_get_frontmatter_or_manifest(frontmatter, manifest, "effort"))
            or str(previous.get("effort") or "").strip()
            or None
        )
        model = str(
            _get_frontmatter_or_manifest(frontmatter, manifest, "model")
            or previous.get("model")
            or ""
        ).strip()
        agent = str(
            _get_frontmatter_or_manifest(frontmatter, manifest, "agent")
            or previous.get("agent")
            or ""
        ).strip()
        paths = _normalize_paths(
            _get_frontmatter_or_manifest(frontmatter, manifest, "paths")
            or previous.get("paths")
        )
        allowed_tools = _normalize_allowed_tools(
            _get_frontmatter_or_manifest(frontmatter, manifest, "allowed-tools", "allowed_tools")
            or previous.get("allowed_tools")
        )
        hooks = _get_frontmatter_or_manifest(frontmatter, manifest, "hooks")
        if not isinstance(hooks, dict):
            hooks = previous.get("hooks") if isinstance(previous.get("hooks"), dict) else {}
        shell = _get_frontmatter_or_manifest(frontmatter, manifest, "shell")
        if not isinstance(shell, dict):
            shell = previous.get("shell") if isinstance(previous.get("shell"), dict) else {}

        record: dict[str, Any] = {
            "schema_version": INDEX_SCHEMA_VERSION,
            "id": skill_id,
            "skill_id": skill_id,
            "name": name,
            "aliases": aliases,
            "description": description,
            "when_to_use": when_to_use,
            "argument_hint": argument_hint,
            "argument_names": argument_names,
            "version": version,
            "source": source_value,
            "loaded_from": str(previous.get("loaded_from") or "skills"),
            "installed_path": str(skill_dir),
            "installed_realpath": installed_realpath,
            "enabled": bool(previous.get("enabled", True)),
            "status": "active",
            "user_invocable": _normalize_bool(
                _get_frontmatter_or_manifest(frontmatter, manifest, "user-invocable", "user_invocable"),
                bool(previous.get("user_invocable", True)),
            ),
            "disable_model_invocation": _normalize_bool(
                _get_frontmatter_or_manifest(frontmatter, manifest, "disable-model-invocation", "disable_model_invocation"),
                bool(previous.get("disable_model_invocation", False)),
            ),
            "paths": paths,
            "allowed_tools": allowed_tools,
            "execution_context": execution_context,
            "agent": agent or None,
            "effort": effort,
            "model": model or None,
            "hooks": hooks,
            "shell": shell,
            "tags": manifest.get("tags") if isinstance(manifest.get("tags"), list) else previous.get("tags") or [],
            "requires": requires,
            "resources": resources,
            # Legacy compatibility fields kept for existing consumers/tests.
            "script_files": resources["script_files"],
            "has_skill_md": resources["has_skill_md"],
            "has_references": resources["has_references"],
            "has_templates": resources["has_templates"],
            "content_hash": current_hash,
            "hash": current_hash,
            "mtime": mtime,
            "created_at": str(previous.get("created_at") or now),
            "updated_at": now if changed else str(previous.get("updated_at") or now),
        }
        return record, changed

    def reindex(self, *, scope: str = "incremental") -> dict[str, Any]:
        mode = scope if scope in {"incremental", "full"} else "incremental"
        current_rows = self.list_records()
        current_map: dict[str, dict[str, Any]] = {}
        for row in current_rows:
            if not isinstance(row, dict):
                continue
            skill_id = str(row.get("skill_id") or row.get("id") or "").strip()
            if skill_id:
                current_map[skill_id] = row

        added = 0
        updated = 0
        invalid = 0
        removed = 0
        duplicate_realpaths = 0
        next_rows: list[dict[str, Any]] = []
        seen: set[str] = set()
        seen_realpaths: set[str] = set()

        for item in sorted(self.skills_root.iterdir(), key=lambda p: p.name):
            if not item.is_dir():
                continue
            if item.name.startswith("."):
                continue
            skill_id = item.name
            seen.add(skill_id)
            previous = current_map.get(skill_id)
            scripts_dir = resolve_skill_scripts_dir(item)
            skill_md_dir = resolve_skill_md_dir(item)
            skill_root = skill_md_dir or scripts_dir
            if skill_root is None:
                invalid += 1
                continue
            realpath = str(skill_root.resolve())
            if realpath in seen_realpaths:
                duplicate_realpaths += 1
                logger.info(
                    "skills_reindex_skip_duplicate_realpath",
                    extra={"skill_id": skill_id, "path": str(skill_root), "realpath": realpath},
                )
                continue
            seen_realpaths.add(realpath)
            record, changed = self._build_record(
                skill_id=skill_id,
                skill_dir=skill_root,
                source=str(previous.get("source") if isinstance(previous, dict) and previous.get("source") else "manual"),
                previous=previous,
                force=(mode == "full"),
            )
            next_rows.append(record)
            if previous is None:
                added += 1
            elif changed:
                updated += 1

        for skill_id in current_map.keys():
            if skill_id not in seen:
                removed += 1

        self.write_index(next_rows)
        result = {
            "scope": mode,
            "skills_root": str(self.skills_root),
            "added": added,
            "updated": updated,
            "removed": removed,
            "invalid": invalid,
            "duplicate_realpaths": duplicate_realpaths,
            "total": len(next_rows),
        }
        logger.info("skills_reindex_complete", extra=result)
        return result

    def upsert_after_install(self, skill_id: str, *, source: str = "manual") -> dict[str, Any]:
        candidate = self.skills_root / skill_id
        scripts_dir = resolve_skill_scripts_dir(candidate)
        skill_md_dir = resolve_skill_md_dir(candidate)
        skill_root = skill_md_dir or scripts_dir
        if skill_root is None:
            raise ValueError(f"invalid skill package: {skill_id} missing scripts/ and SKILL.md")

        current_rows = self.list_records()
        current_map = {
            str(row.get("skill_id") or row.get("id")): row
            for row in current_rows
            if isinstance(row, dict) and str(row.get("skill_id") or row.get("id") or "").strip()
        }
        previous = current_map.get(skill_id)
        record, _ = self._build_record(
            skill_id=skill_id,
            skill_dir=skill_root,
            source=source,
            previous=previous if isinstance(previous, dict) else None,
            force=True,
        )
        current_map[skill_id] = record
        self.write_index(list(current_map.values()))
        return record
