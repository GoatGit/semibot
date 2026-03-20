from src.skills.skill_injection_tracker import SkillInjectionTracker


def test_tracker_rebuild_from_messages_marks_unknown_mtime() -> None:
    tracker = SkillInjectionTracker.rebuild_from_messages(
        [
            {
                "role": "tool",
                "name": "skill_context/deep-research",
                "content": "cached skill payload",
            }
        ]
    )

    assert tracker.is_injected("deep-research") is True
    assert tracker.get_injected_content("deep-research") == "cached skill payload"
    assert tracker.can_reinject("deep-research") is True


def test_tracker_mark_compressed_requires_reinjection() -> None:
    tracker = SkillInjectionTracker()
    tracker.mark_injected("deep-research", chars=10, content="payload", content_mtime=1.0)

    assert tracker.is_injected("deep-research", current_mtime=1.0) is True
    tracker.mark_compressed("deep-research")
    assert tracker.is_injected("deep-research", current_mtime=1.0) is False


def test_tracker_resource_cache_respects_mtime() -> None:
    tracker = SkillInjectionTracker()
    tracker.mark_resource_read("deep-research", "reference/methodology.md", "v1", content_mtime=1.0)

    assert (
        tracker.get_cached_resource("deep-research", "reference/methodology.md", current_mtime=1.0) == "v1"
    )
    assert tracker.get_cached_resource("deep-research", "reference/methodology.md", current_mtime=2.0) is None
