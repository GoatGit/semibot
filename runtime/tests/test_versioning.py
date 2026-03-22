from __future__ import annotations

import ssl

from src.product import versioning


def test_ssl_context_uses_certifi_bundle_when_available(monkeypatch) -> None:
    class _FakeCertifi:
        @staticmethod
        def where() -> str:
            return "/tmp/fake-certifi.pem"

    captured: dict[str, str | None] = {"cafile": None}

    def _fake_create_default_context(*, cafile: str | None = None) -> ssl.SSLContext:
        captured["cafile"] = cafile
        return ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)

    monkeypatch.setattr(versioning, "certifi", _FakeCertifi())
    monkeypatch.setattr(versioning.ssl, "create_default_context", _fake_create_default_context)

    versioning._ssl_context()

    assert captured["cafile"] == "/tmp/fake-certifi.pem"


def test_ssl_context_falls_back_to_system_store_when_certifi_missing(monkeypatch) -> None:
    captured: dict[str, str | None] = {"cafile": "sentinel"}

    def _fake_create_default_context(*, cafile: str | None = None) -> ssl.SSLContext:
        captured["cafile"] = cafile
        return ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)

    monkeypatch.setattr(versioning, "certifi", None)
    monkeypatch.setattr(versioning.ssl, "create_default_context", _fake_create_default_context)

    versioning._ssl_context()

    assert captured["cafile"] is None
