"""Builtin HTTP client tool for generic REST integration."""

from __future__ import annotations

import asyncio
import os
from typing import Any
from urllib.parse import parse_qsl, urlencode, urlparse, urlunparse

import httpx

from src.server.config_store import RuntimeConfigStore
from src.skills.base import BaseTool, ToolResult

_LOCAL_BLOCKLIST = {"localhost", "127.0.0.1", "::1", "0.0.0.0"}


def _to_bool(value: Any, default: bool = False) -> bool:
    if isinstance(value, bool):
        return value
    if value is None:
        return default
    if isinstance(value, str):
        normalized = value.strip().lower()
        if normalized in {"1", "true", "yes", "on"}:
            return True
        if normalized in {"0", "false", "no", "off"}:
            return False
    return bool(value)


def _parse_domain_rules(value: Any) -> list[str]:
    if isinstance(value, str):
        return [item.strip().lower() for item in value.split(",") if item.strip()]
    if isinstance(value, list):
        return [str(item).strip().lower() for item in value if str(item).strip()]
    return []


def _host_matches_rule(host: str, rule: str) -> bool:
    normalized_host = host.strip().lower()
    normalized_rule = rule.strip().lower().lstrip(".")
    if not normalized_host or not normalized_rule:
        return False
    return normalized_host == normalized_rule or normalized_host.endswith(f".{normalized_rule}")


def _as_string_map(value: Any) -> dict[str, str]:
    if not isinstance(value, dict):
        return {}
    out: dict[str, str] = {}
    for key, raw in value.items():
        key_text = str(key).strip()
        if not key_text:
            continue
        if raw is None:
            continue
        out[key_text] = str(raw)
    return out


class HttpClientTool(BaseTool):
    """Execute HTTP requests with auth and retry controls."""

    def __init__(self) -> None:
        self.timeout_ms = int(os.getenv("SEMIBOT_HTTP_CLIENT_TIMEOUT_MS", "15000"))
        self.retry_attempts = int(os.getenv("SEMIBOT_HTTP_CLIENT_RETRY_ATTEMPTS", "2"))
        self.max_response_chars = int(os.getenv("SEMIBOT_HTTP_CLIENT_MAX_RESPONSE_CHARS", "20000"))
        self.allow_localhost = _to_bool(os.getenv("SEMIBOT_HTTP_CLIENT_ALLOW_LOCALHOST"), False)
        self.allowed_domains = _parse_domain_rules(os.getenv("SEMIBOT_HTTP_CLIENT_ALLOWED_DOMAINS"))
        self.blocked_domains = _parse_domain_rules(os.getenv("SEMIBOT_HTTP_CLIENT_BLOCKED_DOMAINS"))
        if not self.blocked_domains:
            self.blocked_domains = sorted(_LOCAL_BLOCKLIST)
        self.default_base_url = str(os.getenv("SEMIBOT_HTTP_CLIENT_BASE_URL", "")).strip()
        self.default_api_key = str(os.getenv("SEMIBOT_HTTP_CLIENT_API_KEY", "")).strip()
        self.default_auth_type = str(os.getenv("SEMIBOT_HTTP_CLIENT_AUTH_TYPE", "none")).strip().lower()
        self.default_auth_header = str(os.getenv("SEMIBOT_HTTP_CLIENT_AUTH_HEADER", "X-API-Key")).strip() or "X-API-Key"
        self._load_runtime_config()

    @property
    def name(self) -> str:
        return "http_client"

    @property
    def description(self) -> str:
        return "Generic REST HTTP client with auth, retries, and response truncation."

    @property
    def parameters(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "method": {
                    "type": "string",
                    "enum": ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"],
                    "default": "GET",
                },
                "url": {"type": "string", "description": "Absolute request URL."},
                "path": {
                    "type": "string",
                    "description": "Path appended to configured apiEndpoint when url is omitted.",
                },
                "headers": {"type": "object", "description": "HTTP headers."},
                "query": {"type": "object", "description": "Query parameters."},
                "body": {"description": "Request body for non-GET methods."},
                "json_body": {"description": "JSON body alias, preferred for JSON APIs."},
                "auth_type": {
                    "type": "string",
                    "enum": ["none", "bearer", "basic", "api_key"],
                    "default": "none",
                },
                "auth_token": {"type": "string", "description": "Bearer token or API key value."},
                "auth_username": {"type": "string", "description": "Username for basic auth."},
                "auth_password": {"type": "string", "description": "Password for basic auth."},
                "auth_header": {
                    "type": "string",
                    "description": "Header name for auth_type=api_key.",
                    "default": "X-API-Key",
                },
                "timeout_ms": {"type": "integer", "description": "Request timeout in milliseconds."},
                "retry_attempts": {"type": "integer", "description": "Retry attempts on transport/5xx errors."},
                "max_response_chars": {
                    "type": "integer",
                    "description": "Maximum number of characters returned in body.",
                },
            },
            "required": [],
        }

    def _load_runtime_config(self) -> None:
        try:
            store = RuntimeConfigStore(db_path=os.getenv("SEMIBOT_EVENTS_DB_PATH"))
            item = store.get_tool_by_name(self.name)
            config = item.get("config") if isinstance(item, dict) else {}
            if not isinstance(config, dict):
                return

            timeout = config.get("timeout")
            if isinstance(timeout, (int, float)) and timeout > 0:
                self.timeout_ms = int(timeout)

            retries = config.get("retryAttempts")
            if isinstance(retries, int) and retries >= 0:
                self.retry_attempts = retries

            max_chars = config.get("maxResponseChars")
            if isinstance(max_chars, int) and max_chars >= 200:
                self.max_response_chars = max_chars

            if "allowLocalhost" in config:
                self.allow_localhost = _to_bool(config.get("allowLocalhost"), self.allow_localhost)

            allowed = _parse_domain_rules(config.get("allowedDomains"))
            blocked = _parse_domain_rules(config.get("blockedDomains"))
            if allowed:
                self.allowed_domains = allowed
            if blocked:
                self.blocked_domains = blocked

            endpoint = config.get("apiEndpoint")
            if isinstance(endpoint, str) and endpoint.strip():
                self.default_base_url = endpoint.strip()

            api_key = config.get("apiKey")
            if isinstance(api_key, str) and api_key.strip():
                self.default_api_key = api_key.strip()

            auth_type = str(config.get("authType") or "").strip().lower()
            if auth_type in {"none", "bearer", "basic", "api_key"}:
                self.default_auth_type = auth_type

            auth_header = str(config.get("authHeader") or "").strip()
            if auth_header:
                self.default_auth_header = auth_header
        except Exception:
            return

    def _build_url(self, url: str | None, path: str | None, query: dict[str, Any]) -> str:
        resolved_url = (url or "").strip()
        if not resolved_url:
            base = self.default_base_url.strip()
            if not base:
                return ""
            relative = (path or "").strip()
            if relative.startswith("http://") or relative.startswith("https://"):
                resolved_url = relative
            elif relative:
                resolved_url = f"{base.rstrip('/')}/{relative.lstrip('/')}"
            else:
                resolved_url = base

        parsed = urlparse(resolved_url)
        pairs = list(parse_qsl(parsed.query, keep_blank_values=True))
        for key, value in query.items():
            pairs.append((str(key), str(value)))
        merged_query = urlencode(pairs, doseq=True)
        return urlunparse(parsed._replace(query=merged_query))

    def _validate_url(self, raw_url: str) -> tuple[bool, str | None]:
        parsed = urlparse(raw_url)
        if parsed.scheme not in {"http", "https"}:
            return False, "Only http/https URLs are allowed."

        host = (parsed.hostname or "").strip().lower()
        if not host:
            return False, "Invalid URL host."

        if not self.allow_localhost and host in _LOCAL_BLOCKLIST:
            return False, "Access to localhost/loopback is blocked."

        if self.allowed_domains and not any(_host_matches_rule(host, rule) for rule in self.allowed_domains):
            return False, f"Host '{host}' is not in allowedDomains."

        if self.blocked_domains and any(_host_matches_rule(host, rule) for rule in self.blocked_domains):
            return False, f"Host '{host}' is blocked."

        return True, None

    async def execute(
        self,
        method: str = "GET",
        url: str | None = None,
        path: str | None = None,
        headers: dict[str, Any] | None = None,
        query: dict[str, Any] | None = None,
        body: Any = None,
        json_body: Any = None,
        auth_type: str | None = None,
        auth_token: str | None = None,
        auth_username: str | None = None,
        auth_password: str | None = None,
        auth_header: str | None = None,
        timeout_ms: int | None = None,
        retry_attempts: int | None = None,
        max_response_chars: int | None = None,
        **_: Any,
    ) -> ToolResult:
        self._load_runtime_config()
        method_upper = str(method or "GET").strip().upper()
        if method_upper not in {"GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"}:
            return ToolResult.error_result(f"Unsupported method: {method_upper}")

        query_map = _as_string_map(query or {})
        request_url = self._build_url(url, path, query_map)
        if not request_url:
            return ToolResult.error_result("url is required (or configure apiEndpoint and provide path).")

        valid, error = self._validate_url(request_url)
        if not valid:
            return ToolResult.error_result(error or "Invalid URL")

        timeout_seconds = max(1.0, float(timeout_ms if timeout_ms is not None else self.timeout_ms) / 1000.0)
        retries = retry_attempts if isinstance(retry_attempts, int) and retry_attempts >= 0 else self.retry_attempts
        retries = min(6, retries)
        max_chars = (
            max_response_chars
            if isinstance(max_response_chars, int) and max_response_chars > 0
            else self.max_response_chars
        )

        request_headers = _as_string_map(headers or {})
        auth_mode = str(auth_type if auth_type is not None else self.default_auth_type or "none").strip().lower()
        token = (auth_token or "").strip() or self.default_api_key
        if auth_mode == "bearer" and token:
            request_headers["Authorization"] = f"Bearer {token}"
        elif auth_mode == "api_key" and token:
            header_name = (auth_header or self.default_auth_header or "X-API-Key").strip() or "X-API-Key"
            request_headers[header_name] = token

        auth_tuple: tuple[str, str] | None = None
        if auth_mode == "basic":
            user = (auth_username or "").strip()
            password = auth_password or ""
            if not user:
                return ToolResult.error_result("auth_username is required for basic auth.")
            auth_tuple = (user, password)

        payload_json = json_body if json_body is not None else None
        payload_content = None if payload_json is not None else body

        last_error: str | None = None
        response: httpx.Response | None = None

        for attempt in range(retries + 1):
            try:
                async with httpx.AsyncClient(timeout=timeout_seconds, follow_redirects=True) as client:
                    response = await client.request(
                        method_upper,
                        request_url,
                        headers=request_headers,
                        json=payload_json,
                        content=payload_content if isinstance(payload_content, (bytes, str)) else None,
                        data=payload_content
                        if payload_json is None and not isinstance(payload_content, (bytes, str, type(None)))
                        else None,
                        auth=auth_tuple,
                    )
                if response.status_code >= 500 and attempt < retries:
                    await asyncio.sleep(0.2 * (attempt + 1))
                    continue
                break
            except (httpx.TimeoutException, httpx.TransportError) as exc:
                last_error = str(exc)
                if attempt >= retries:
                    return ToolResult.error_result(f"HTTP request failed: {exc}")
                await asyncio.sleep(0.2 * (attempt + 1))

        if response is None:
            return ToolResult.error_result(last_error or "HTTP request failed")

        response_text = response.text or ""
        truncated = len(response_text) > max_chars
        if truncated:
            response_text = response_text[:max_chars]

        json_payload: Any = None
        content_type = response.headers.get("content-type", "")
        if "json" in content_type.lower():
            try:
                json_payload = response.json()
            except Exception:
                json_payload = None

        headers_out: dict[str, str] = {}
        for key in sorted(response.headers.keys()):
            if len(headers_out) >= 40:
                break
            headers_out[key] = response.headers.get(key, "")

        return ToolResult.success_result(
            {
                "request": {
                    "method": method_upper,
                    "url": request_url,
                },
                "response": {
                    "status_code": response.status_code,
                    "reason_phrase": response.reason_phrase,
                    "url": str(response.url),
                    "content_type": content_type,
                    "headers": headers_out,
                    "body": response_text,
                    "json": json_payload,
                    "truncated": truncated,
                },
            }
        )
