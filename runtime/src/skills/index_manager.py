"""Skills metadata index manager for installed skills."""

from __future__ import annotations

import hashlib
import json
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from src.utils.logging import get_logger

logger = get_logger(__name__)

INDEX_FILENAME = ".index.json"
STATE_FILENAME = ".state.json"
INDEX_SCHEMA_VERSION = 2


def _iso_now() -> str:
    return datetime.now(UTC).isoformat()


def _read_json_file(path: Path) -> dict[str, Any] | None:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None
    return payload if isinstance(payload, dict) else None


def _read_description(skill_dir: Path, fallback_name: str) -> str:
    skill_md = skill_dir / "SKILL.md"
    if not skill_md.exists():
        return f"Installed skill: {fallback_name}"
    lines = skill_md.read_text(encoding="utf-8", errors="ignore").splitlines()
    frontmatter_lines: list[str] = []
    body_start = 0
    if lines and lines[0].strip() == "---":
        for idx in range(1, len(lines)):
            row = lines[idx].strip()
            if row == "---":
                body_start = idx + 1
                break
            frontmatter_lines.append(row)

    # Prefer explicit YAML frontmatter description when present.
    for row in frontmatter_lines:
        if ":" not in row:
            continue
        key, value = row.split(":", 1)
        if key.strip().lower() != "description":
            continue
        desc = value.strip().strip('"').strip("'")
        if desc:
            return desc

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


def _scan_script_files(skill_dir: Path) -> list[str]:
    scripts_dir = skill_dir / "scripts"
    if not scripts_dir.exists() or not scripts_dir.is_dir():
        return []
    return sorted(
        str(path.relative_to(skill_dir)).replace("\\", "/")
        for path in scripts_dir.rglob("*")
        if path.is_file()
    )


def _parse_requires(manifest: dict[str, Any]) -> dict[str, Any]:
    requires = manifest.get("requires")
    if not isinstance(requires, dict):
        return {"binaries": [], "env_vars": [], "python": []}

    binaries = requires.get("binaries") if isinstance(requires.get("binaries"), list) else []
    env_vars = requires.get("env_vars") if isinstance(requires.get("env_vars"), list) else []
    python = requires.get("python") if isinstance(requires.get("python"), list) else []

    def _as_strings(items: list[Any]) -> list[str]:
        values: list[str] = []
        for item in items:
            if not isinstance(item, str):
                continue
            text = item.strip()
            if text:
                values.append(text)
        return values

    return {
        "binaries": _as_strings(binaries),
        "env_vars": _as_strings(env_vars),
        "python": _as_strings(python),
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
        payload["schema_version"] = int(payload.get("schema_version") or INDEX_SCHEMA_VERSION)
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
        current_hash = _content_hash(skill_dir)
        mtime = int(skill_dir.stat().st_mtime)
        hash_unchanged = str(previous.get("hash") or "") == current_hash
        mtime_unchanged = int(previous.get("mtime") or 0) == mtime
        changed = force or not (hash_unchanged and mtime_unchanged)

        record: dict[str, Any] = {
            "skill_id": skill_id,
            "name": str(manifest.get("name") or previous.get("name") or skill_id),
            "description": str(
                manifest.get("description")
                or previous.get("description")
                or _read_description(skill_dir, skill_id)
            ),
            "version": str(manifest.get("version") or previous.get("version") or "0.0.0-local"),
            "source": source or str(previous.get("source") or "manual"),
            "installed_path": str(skill_dir),
            "tags": manifest.get("tags") if isinstance(manifest.get("tags"), list) else previous.get("tags") or [],
            "requires": _parse_requires(manifest) if manifest else previous.get("requires") or {"binaries": [], "env_vars": [], "python": []},
            "script_files": _scan_script_files(skill_dir),
            "has_skill_md": (skill_dir / "SKILL.md").exists(),
            "has_references": (skill_dir / "reference").is_dir() or (skill_dir / "references").is_dir(),
            "has_templates": (skill_dir / "templates").is_dir(),
            "enabled": bool(previous.get("enabled", True)),
            "status": "active",
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
            skill_id = str(row.get("skill_id") or "").strip()
            if skill_id:
                current_map[skill_id] = row

        added = 0
        updated = 0
        invalid = 0
        removed = 0
        next_rows: list[dict[str, Any]] = []
        seen: set[str] = set()

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
                # Non-skill directories are ignored.
                continue
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
            str(row.get("skill_id")): row
            for row in current_rows
            if isinstance(row, dict) and str(row.get("skill_id") or "").strip()
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
