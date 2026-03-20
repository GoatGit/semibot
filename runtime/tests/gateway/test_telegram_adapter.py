"""Tests for telegram adapter normalization."""

from __future__ import annotations

from src.gateway.adapters.telegram_adapter import normalize_update


def test_normalize_update_extracts_document_attachment() -> None:
    normalized = normalize_update(
        {
            "update_id": 99,
            "message": {
                "message_id": 7,
                "chat": {"id": -1001, "type": "group"},
                "from": {"id": 1234},
                "caption": "请处理这个文件",
                "document": {
                    "file_id": "doc_file_1",
                    "file_name": "report.csv",
                    "mime_type": "text/csv",
                    "file_size": 1024,
                },
            },
        },
        bot_id="8646880953",
    )
    assert isinstance(normalized, dict)
    payload = normalized.get("payload")
    assert isinstance(payload, dict)
    assert payload.get("text") == "请处理这个文件"
    attachments = payload.get("attachments")
    assert isinstance(attachments, list)
    assert len(attachments) == 1
    item = attachments[0]
    assert item["kind"] == "document"
    assert item["file_id"] == "doc_file_1"
    assert item["file_name"] == "report.csv"
