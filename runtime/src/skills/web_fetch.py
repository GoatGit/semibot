"""Builtin lightweight web fetch + readability extraction tool."""

from __future__ import annotations

import html
import os
import re
from html.parser import HTMLParser
from typing import Any
from urllib.parse import urlparse

import httpx

from src.server.config_store import RuntimeConfigStore
from src.skills.base import BaseTool, ToolResult

_LOCAL_BLOCKLIST = {"localhost", "127.0.0.1", "::1", "0.0.0.0"}
_SKIP_TAGS = {"script", "style", "noscript", "svg"}


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


def _normalize_whitespace(text: str) -> str:
    text = text.replace("\xa0", " ")
    text = re.sub(r"[ \t]+\n", "\n", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    text = re.sub(r"[ \t]{2,}", " ", text)
    return text.strip()


class _HTMLTextExtractor(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self._skip_stack: list[str] = []
        self._chunks: list[str] = []
        self._title_parts: list[str] = []
        self._in_title = False
        self.links: list[dict[str, str]] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        tag_lower = tag.lower()
        if tag_lower in _SKIP_TAGS:
            self._skip_stack.append(tag_lower)
            return
        if tag_lower == "title":
            self._in_title = True
            return
        if tag_lower in {"p", "div", "section", "article", "li", "br", "h1", "h2", "h3", "h4"}:
            self._chunks.append("\n")
        if tag_lower == "a":
            href = ""
            for key, value in attrs:
                if key.lower() == "href" and value:
                    href = value.strip()
                    break
            if href:
                self.links.append({"href": href})

    def handle_endtag(self, tag: str) -> None:
        tag_lower = tag.lower()
        if self._skip_stack and self._skip_stack[-1] == tag_lower:
            self._skip_stack.pop()
        if tag_lower == "title":
            self._in_title = False
        if tag_lower in {"p", "div", "section", "article", "li", "h1", "h2", "h3", "h4"}:
            self._chunks.append("\n")

    def handle_data(self, data: str) -> None:
        if self._skip_stack:
            return
        text = data.strip()
        if not text:
            return
        if self._in_title:
            self._title_parts.append(text)
        else:
            self._chunks.append(text)

    @property
    def title(self) -> str:
        return _normalize_whitespace(" ".join(self._title_parts))

    @property
    def text(self) -> str:
        return _normalize_whitespace(" ".join(self._chunks))


class WebFetchTool(BaseTool):
    """Fetch and extract webpage content without full browser automation."""

    def __init__(self) -> None:
        self.timeout_ms = int(os.getenv("SEMIBOT_WEB_FETCH_TIMEOUT_MS", "12000"))
        self.max_chars = int(os.getenv("SEMIBOT_WEB_FETCH_MAX_CHARS", "20000"))
        self.allow_localhost = _to_bool(os.getenv("SEMIBOT_WEB_FETCH_ALLOW_LOCALHOST"), False)
        self.allowed_domains = _parse_domain_rules(os.getenv("SEMIBOT_WEB_FETCH_ALLOWED_DOMAINS"))
        self.blocked_domains = _parse_domain_rules(os.getenv("SEMIBOT_WEB_FETCH_BLOCKED_DOMAINS"))
        if not self.blocked_domains:
            self.blocked_domains = sorted(_LOCAL_BLOCKLIST)
        self._load_runtime_config()

    @property
    def name(self) -> str:
        return "web_fetch"

    @property
    def description(self) -> str:
        return "Fetch webpage and extract title/main text (optionally readability mode)."

    @property
    def parameters(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "url": {"type": "string", "description": "Web page URL."},
                "mode": {
                    "type": "string",
                    "enum": ["readability", "raw"],
                    "default": "readability",
                },
                "timeout_ms": {"type": "integer", "description": "HTTP timeout in milliseconds."},
                "max_chars": {"type": "integer", "description": "Maximum extracted text length."},
                "include_links": {"type": "boolean", "default": True},
                "include_html": {"type": "boolean", "default": False},
            },
            "required": ["url"],
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

            max_chars = config.get("maxResponseChars")
            if isinstance(max_chars, int) and max_chars >= 200:
                self.max_chars = max_chars

            if "allowLocalhost" in config:
                self.allow_localhost = _to_bool(config.get("allowLocalhost"), self.allow_localhost)

            allowed = _parse_domain_rules(config.get("allowedDomains"))
            blocked = _parse_domain_rules(config.get("blockedDomains"))
            if allowed:
                self.allowed_domains = allowed
            if blocked:
                self.blocked_domains = blocked
        except Exception:
            return

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

    def _extract_main_html(self, html_text: str, mode: str) -> str:
        if mode != "readability":
            return html_text

        candidates = [
            re.search(r"<article\b[^>]*>(.*?)</article>", html_text, flags=re.IGNORECASE | re.DOTALL),
            re.search(r"<main\b[^>]*>(.*?)</main>", html_text, flags=re.IGNORECASE | re.DOTALL),
            re.search(r"<body\b[^>]*>(.*?)</body>", html_text, flags=re.IGNORECASE | re.DOTALL),
        ]
        for candidate in candidates:
            if candidate and candidate.group(1).strip():
                return candidate.group(1)
        return html_text

    async def execute(
        self,
        url: str,
        mode: str = "readability",
        timeout_ms: int | None = None,
        max_chars: int | None = None,
        include_links: bool = True,
        include_html: bool = False,
        **_: Any,
    ) -> ToolResult:
        self._load_runtime_config()
        request_url = str(url or "").strip()
        if not request_url:
            return ToolResult.error_result("url is required")
        valid, error = self._validate_url(request_url)
        if not valid:
            return ToolResult.error_result(error or "Invalid URL")

        mode_normalized = str(mode or "readability").strip().lower()
        if mode_normalized not in {"readability", "raw"}:
            return ToolResult.error_result("mode must be readability or raw")

        timeout_seconds = max(1.0, float(timeout_ms if timeout_ms is not None else self.timeout_ms) / 1000.0)
        char_limit = max_chars if isinstance(max_chars, int) and max_chars > 0 else self.max_chars

        try:
            async with httpx.AsyncClient(timeout=timeout_seconds, follow_redirects=True) as client:
                response = await client.get(request_url, headers={"User-Agent": "semibot-web-fetch/1.0"})
        except (httpx.TimeoutException, httpx.TransportError) as exc:
            return ToolResult.error_result(f"web_fetch request failed: {exc}")

        content_type = response.headers.get("content-type", "")
        html_text = response.text or ""
        main_html = self._extract_main_html(html_text, mode_normalized)
        extractor = _HTMLTextExtractor()
        extractor.feed(main_html)
        extracted_text = extractor.text
        if not extracted_text:
            extracted_text = html.unescape(html_text)

        truncated = len(extracted_text) > char_limit
        if truncated:
            extracted_text = extracted_text[:char_limit]

        seen_links: set[str] = set()
        links: list[str] = []
        if include_links:
            for item in extractor.links:
                href = (item.get("href") or "").strip()
                if not href or href in seen_links:
                    continue
                seen_links.add(href)
                links.append(href)
                if len(links) >= 100:
                    break

        result: dict[str, Any] = {
            "url": str(response.url),
            "status_code": response.status_code,
            "content_type": content_type,
            "title": extractor.title,
            "text": extracted_text,
            "truncated": truncated,
            "mode": mode_normalized,
        }
        if include_links:
            result["links"] = links
        if include_html:
            html_truncated = len(main_html) > char_limit
            result["html"] = main_html[:char_limit] if html_truncated else main_html
            result["html_truncated"] = html_truncated
        return ToolResult.success_result(result)
