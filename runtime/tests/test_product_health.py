from __future__ import annotations

from urllib.error import HTTPError

from src.product.health import probe_http


def test_probe_http_treats_redirect_as_healthy(monkeypatch) -> None:
    def _raise_redirect(*args, **kwargs):
        raise HTTPError(
            url="http://127.0.0.1:3000/",
            code=307,
            msg="Temporary Redirect",
            hdrs=None,
            fp=None,
        )

    monkeypatch.setattr("src.product.health.checks.urlopen", _raise_redirect)

    result = probe_http("http://127.0.0.1:3000/")

    assert result.status == "ok"
    assert result.message == "http 307"


def test_probe_http_treats_client_error_as_healthy(monkeypatch) -> None:
    def _raise_client_error(*args, **kwargs):
        raise HTTPError(
            url="http://127.0.0.1:3000/",
            code=401,
            msg="Unauthorized",
            hdrs=None,
            fp=None,
        )

    monkeypatch.setattr("src.product.health.checks.urlopen", _raise_client_error)

    result = probe_http("http://127.0.0.1:3000/")

    assert result.status == "ok"
    assert result.message == "http 401"
