"""Tests for Telegram outbound notifier file delivery."""

from __future__ import annotations

from pathlib import Path

import pytest

from src.gateway.notifiers.telegram_notifier import TelegramNotifier


@pytest.mark.asyncio
async def test_telegram_notifier_send_file_from_local_path(tmp_path: Path) -> None:
    doc_path = tmp_path / "report.pdf"
    doc_path.write_bytes(b"%PDF-1.4 test")

    sent_messages: list[dict] = []
    sent_docs: list[dict] = []

    async def _send_message(token: str, payload: dict, timeout: float) -> None:
        sent_messages.append({"token": token, "payload": payload, "timeout": timeout})

    async def _send_doc(token: str, data: dict, file_upload, timeout: float) -> None:
        sent_docs.append({"token": token, "data": dict(data), "file_upload": file_upload, "timeout": timeout})

    notifier = TelegramNotifier(
        bot_token="123456:abc",
        default_chat_id="-1001",
        send_fn=_send_message,
        send_document_fn=_send_doc,
    )

    ok = await notifier.send_notify_payload(
        {
            "content": "这是报告，请查收",
            "chat_id": "-1001",
            "files": [{"local_path": str(doc_path), "filename": "report.pdf", "mime_type": "application/pdf"}],
        }
    )

    assert ok is True
    assert sent_messages == []
    assert len(sent_docs) == 1
    assert sent_docs[0]["data"]["chat_id"] == "-1001"
    assert sent_docs[0]["data"]["caption"] == "这是报告，请查收"
    assert sent_docs[0]["file_upload"][0] == "report.pdf"


@pytest.mark.asyncio
async def test_telegram_notifier_fallback_to_text_when_files_invalid() -> None:
    sent_messages: list[dict] = []
    sent_docs: list[dict] = []

    async def _send_message(token: str, payload: dict, timeout: float) -> None:
        sent_messages.append({"token": token, "payload": payload, "timeout": timeout})

    async def _send_doc(token: str, data: dict, file_upload, timeout: float) -> None:
        sent_docs.append({"token": token, "data": dict(data), "file_upload": file_upload, "timeout": timeout})

    notifier = TelegramNotifier(
        bot_token="123456:abc",
        default_chat_id="-1001",
        send_fn=_send_message,
        send_document_fn=_send_doc,
    )

    ok = await notifier.send_notify_payload(
        {
            "content": "只发文本",
            "chat_id": "-1001",
            "files": [{"local_path": "/path/not-exist.pdf", "filename": "bad.pdf"}],
        }
    )

    assert ok is True
    assert len(sent_messages) == 1
    assert sent_messages[0]["payload"]["text"] == "只发文本"
    assert sent_docs == []
