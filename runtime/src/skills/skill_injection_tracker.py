"""Session-local tracker for injected skill context and cached resource reads."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import UTC, datetime


def _utc_now() -> datetime:
    return datetime.now(UTC)


@dataclass
class InjectionRecord:
    skill_id: str
    injected_at: datetime
    chars: int
    content: str = ""
    content_mtime: float | None = None
    mtime_unknown: bool = False
    compressed: bool = False


@dataclass
class ResourceReadRecord:
    skill_id: str
    file_path: str
    content: str
    content_mtime: float | None
    read_at: datetime


@dataclass
class SkillInjectionTracker:
    """Track skill context injected into planning and cache resource reads."""

    max_reinjection_per_skill: int = 2
    _injected: dict[str, InjectionRecord] = field(default_factory=dict)
    _injection_count: dict[str, int] = field(default_factory=dict)
    _resource_read: dict[tuple[str, str], ResourceReadRecord] = field(default_factory=dict)

    def is_injected(self, skill_id: str, current_mtime: float | None = None) -> bool:
        record = self._injected.get(skill_id)
        if record is None:
            return False
        if record.compressed:
            return False
        if record.mtime_unknown:
            return True
        if current_mtime is not None and record.content_mtime != current_mtime:
            return False
        return True

    def can_reinject(self, skill_id: str) -> bool:
        return self._injection_count.get(skill_id, 0) < self.max_reinjection_per_skill

    def get_injected_content(self, skill_id: str) -> str:
        record = self._injected.get(skill_id)
        return record.content if record else ""

    def mark_injected(
        self,
        skill_id: str,
        *,
        chars: int,
        content: str,
        content_mtime: float | None = None,
        mtime_unknown: bool = False,
    ) -> None:
        self._injected[skill_id] = InjectionRecord(
            skill_id=skill_id,
            injected_at=_utc_now(),
            chars=chars,
            content=content,
            content_mtime=content_mtime,
            mtime_unknown=mtime_unknown,
            compressed=False,
        )
        self._injection_count[skill_id] = self._injection_count.get(skill_id, 0) + 1

    def mark_compressed(self, skill_id: str) -> None:
        record = self._injected.get(skill_id)
        if record is None:
            return
        record.compressed = True
        record.content = ""

    def get_injected_skills(self) -> list[str]:
        return list(self._injected.keys())

    def total_injected_chars(self) -> int:
        return sum(record.chars for record in self._injected.values() if not record.compressed)

    def get_cached_resource(
        self,
        skill_id: str,
        file_path: str,
        *,
        current_mtime: float | None = None,
    ) -> str | None:
        record = self._resource_read.get((skill_id, file_path))
        if record is None:
            return None
        if current_mtime is not None and record.content_mtime is not None and record.content_mtime != current_mtime:
            return None
        return record.content

    def mark_resource_read(
        self,
        skill_id: str,
        file_path: str,
        content: str,
        *,
        content_mtime: float | None = None,
    ) -> None:
        self._resource_read[(skill_id, file_path)] = ResourceReadRecord(
            skill_id=skill_id,
            file_path=file_path,
            content=content,
            content_mtime=content_mtime,
            read_at=_utc_now(),
        )

    @classmethod
    def rebuild_from_messages(cls, messages: list[dict]) -> "SkillInjectionTracker":
        tracker = cls()
        for msg in messages:
            if not isinstance(msg, dict):
                continue
            if str(msg.get("role") or "") != "tool":
                continue
            name = str(msg.get("name") or "")
            if not name.startswith("skill_context/"):
                continue
            skill_id = name.split("/", 1)[1].strip()
            if not skill_id:
                continue
            content = str(msg.get("content") or "")
            tracker.mark_injected(
                skill_id,
                chars=len(content),
                content=content,
                content_mtime=None,
                mtime_unknown=True,
            )
        return tracker
