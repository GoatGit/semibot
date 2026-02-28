"""Tests for http_client builtin tool."""

import pytest

from src.skills.http_client import HttpClientTool


@pytest.mark.asyncio
async def test_http_client_requires_url_or_endpoint() -> None:
    tool = HttpClientTool()
    tool.default_base_url = ""
    result = await tool.execute(method="GET")
    assert result.success is False
    assert "url" in (result.error or "").lower()


@pytest.mark.asyncio
async def test_http_client_blocks_localhost_by_default() -> None:
    tool = HttpClientTool()
    result = await tool.execute(method="GET", url="http://localhost:8080/health")
    assert result.success is False
    assert "localhost" in (result.error or "").lower()


def test_http_client_loads_auth_defaults_from_runtime_config(monkeypatch: pytest.MonkeyPatch) -> None:
    class FakeStore:
        def __init__(self, db_path: str | None = None) -> None:
            self.db_path = db_path

        def get_tool_by_name(self, _name: str) -> dict[str, object]:
            return {
                "config": {
                    "authType": "bearer",
                    "authHeader": "X-Custom-Key",
                    "apiKey": "runtime-token",
                    "retryAttempts": 4,
                }
            }

    monkeypatch.setattr("src.skills.http_client.RuntimeConfigStore", FakeStore)

    tool = HttpClientTool()
    assert tool.default_auth_type == "bearer"
    assert tool.default_auth_header == "X-Custom-Key"
    assert tool.default_api_key == "runtime-token"
    assert tool.retry_attempts == 4


@pytest.mark.asyncio
async def test_http_client_uses_default_api_key_auth_header(monkeypatch: pytest.MonkeyPatch) -> None:
    request_args: dict[str, object] = {}

    class DummyResponse:
        def __init__(self, url: str) -> None:
            self.status_code = 200
            self.reason_phrase = "OK"
            self.url = url
            self.headers = {"content-type": "application/json"}
            self.text = '{"ok": true}'

        def json(self) -> dict[str, bool]:
            return {"ok": True}

    class DummyClient:
        def __init__(self, timeout: float, follow_redirects: bool) -> None:
            self.timeout = timeout
            self.follow_redirects = follow_redirects

        async def __aenter__(self) -> "DummyClient":
            return self

        async def __aexit__(self, exc_type, exc, tb) -> None:  # type: ignore[no-untyped-def]
            return None

        async def request(self, method: str, url: str, **kwargs: object) -> DummyResponse:
            request_args["method"] = method
            request_args["url"] = url
            request_args["headers"] = kwargs.get("headers", {})
            return DummyResponse(url)

    monkeypatch.setattr("src.skills.http_client.httpx.AsyncClient", DummyClient)
    monkeypatch.setattr(HttpClientTool, "_load_runtime_config", lambda self: None)

    tool = HttpClientTool()
    tool.default_auth_type = "api_key"
    tool.default_api_key = "secret-token"
    tool.default_auth_header = "X-Test-Key"

    result = await tool.execute(method="GET", url="https://example.com/data")
    assert result.success is True

    headers = request_args.get("headers")
    assert isinstance(headers, dict)
    assert headers.get("X-Test-Key") == "secret-token"
