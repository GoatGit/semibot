"""Skills metadata index manager for installed package skills."""

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
        return f"Execute installed package skill: {fallback_name}"
    for raw in skill_md.read_text(encoding="utf-8", errors="ignore").splitlines():
        line = raw.strip()
        if not line:
            continue
        if line.startswith("#"):
            line = line.lstrip("#").strip()
        if line:
            return line
    return f"Execute installed package skill: {fallback_name}"


def _read_manifest(skill_dir: Path) -> dict[str, Any]:
    for candidate in ("skill.json", "semibot.skill.json"):
        payload = _read_json_file(skill_dir / candidate)
        if payload:
            return payload
    return {}


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
    """Resolve to a directory that contains scripts/main.py."""
    if not candidate.exists() or candidate.is_file():
        return None
    direct = candidate / "scripts" / "main.py"
    if direct.exists():
        return candidate
    for child in candidate.iterdir():
        if not child.is_dir():
            continue
        nested = child / "scripts" / "main.py"
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
            return {"schema_version": 1, "generated_at": _iso_now(), "skills": []}
        payload = _read_json_file(self.index_path)
        if not payload:
            return {"schema_version": 1, "generated_at": _iso_now(), "skills": []}
        rows = payload.get("skills")
        if not isinstance(rows, list):
            payload["skills"] = []
        return payload

    def write_index(self, rows: list[dict[str, Any]]) -> dict[str, Any]:
        payload = {
            "schema_version": 1,
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
            "entry_script": str(manifest.get("entry_script") or previous.get("entry_script") or "scripts/main.py"),
            "skill_md_path": str(manifest.get("skill_md_path") or previous.get("skill_md_path") or "SKILL.md"),
            "tags": manifest.get("tags") if isinstance(manifest.get("tags"), list) else previous.get("tags") or [],
            "requires": _parse_requires(manifest) if manifest else previous.get("requires") or {"binaries": [], "env_vars": [], "python": []},
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
            resolved = resolve_skill_dir(item)
            if resolved is None:
                now = _iso_now()
                invalid += 1
                next_rows.append(
                    {
                        "skill_id": skill_id,
                        "name": str(previous.get("name") if isinstance(previous, dict) else skill_id),
                        "description": "Invalid package: scripts/main.py missing",
                        "version": str(previous.get("version") if isinstance(previous, dict) and previous.get("version") else "0.0.0-local"),
                        "source": str(previous.get("source") if isinstance(previous, dict) and previous.get("source") else "manual"),
                        "installed_path": str(item),
                        "entry_script": "scripts/main.py",
                        "skill_md_path": "SKILL.md",
                        "tags": previous.get("tags") if isinstance(previous, dict) and isinstance(previous.get("tags"), list) else [],
                        "requires": previous.get("requires") if isinstance(previous, dict) and isinstance(previous.get("requires"), dict) else {"binaries": [], "env_vars": [], "python": []},
                        "enabled": bool(previous.get("enabled", True)) if isinstance(previous, dict) else True,
                        "status": "invalid",
                        "hash": str(previous.get("hash") if isinstance(previous, dict) else ""),
                        "mtime": int(item.stat().st_mtime),
                        "created_at": str(previous.get("created_at") if isinstance(previous, dict) and previous.get("created_at") else now),
                        "updated_at": now,
                        "error": "scripts/main.py missing",
                    }
                )
                continue

            record, changed = self._build_record(
                skill_id=skill_id,
                skill_dir=resolved,
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
        resolved = resolve_skill_dir(self.skills_root / skill_id)
        if resolved is None:
            raise ValueError(f"invalid skill package: {skill_id} scripts/main.py missing")

        current_rows = self.list_records()
        current_map = {
            str(row.get("skill_id")): row
            for row in current_rows
            if isinstance(row, dict) and str(row.get("skill_id") or "").strip()
        }
        previous = current_map.get(skill_id)
        record, _ = self._build_record(
            skill_id=skill_id,
            skill_dir=resolved,
            source=source,
            previous=previous if isinstance(previous, dict) else None,
            force=True,
        )
        current_map[skill_id] = record
        self.write_index(list(current_map.values()))
        return record
