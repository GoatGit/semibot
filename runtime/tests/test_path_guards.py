from pathlib import Path

import pytest

from src.gateway.adapters.telegram_adapter import verify_webhook_secret
from src.memory.local_memory import LocalShortTermMemory
from src.session.workspace import session_working_dir
from src.storage.file_manager import FileManager


def test_session_working_dir_rejects_path_traversal() -> None:
    with pytest.raises(ValueError, match="Invalid session_id"):
        session_working_dir("../escape")


@pytest.mark.asyncio
async def test_local_short_term_memory_rejects_path_traversal(tmp_path: Path) -> None:
    memory = LocalShortTermMemory(str(tmp_path))

    with pytest.raises(ValueError, match="Invalid session_id"):
        await memory.append("../escape", "bad")


def test_file_manager_rejects_invalid_file_id(tmp_path: Path) -> None:
    manager = FileManager(base_dir=str(tmp_path))

    assert manager.get_file_path("../escape") is None


def test_telegram_webhook_secret_requires_configured_secret() -> None:
    assert verify_webhook_secret({}, None) is True
    assert verify_webhook_secret({"x-telegram-bot-api-secret-token": "abc"}, "abc") is True
