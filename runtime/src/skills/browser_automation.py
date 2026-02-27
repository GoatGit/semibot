"""Builtin browser automation tool powered by Playwright."""

from __future__ import annotations

import asyncio
import os
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from src.server.config_store import RuntimeConfigStore
from src.skills.base import BaseTool, ToolResult

_LOCAL_BLOCKLIST = {"localhost", "127.0.0.1", "::1", "0.0.0.0"}
_SUPPORTED_BROWSERS = {"chromium", "firefox", "webkit"}


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


@dataclass
class _BrowserSession:
    playwright: Any
    browser: Any
    context: Any
    page: Any
    created_at: float
    last_used_at: float


class BrowserAutomationTool(BaseTool):
    """Automate browser interactions for navigation and page data extraction."""

    def __init__(self) -> None:
        self.default_timeout_ms = int(os.getenv("SEMIBOT_BROWSER_TIMEOUT_MS", "30000"))
        self.default_headless = _to_bool(os.getenv("SEMIBOT_BROWSER_HEADLESS"), True)
        self.browser_type = str(os.getenv("SEMIBOT_BROWSER_TYPE", "chromium")).strip().lower()
        self.max_text_length = int(os.getenv("SEMIBOT_BROWSER_MAX_TEXT_LENGTH", "20000"))
        self.allow_localhost = _to_bool(os.getenv("SEMIBOT_BROWSER_ALLOW_LOCALHOST"), False)
        self.allowed_domains = _parse_domain_rules(os.getenv("SEMIBOT_BROWSER_ALLOWED_DOMAINS"))
        self.blocked_domains = _parse_domain_rules(os.getenv("SEMIBOT_BROWSER_BLOCKED_DOMAINS"))
        if not self.blocked_domains:
            self.blocked_domains = sorted(_LOCAL_BLOCKLIST)
        self.artifact_dir = Path(
            os.getenv(
                "SEMIBOT_BROWSER_ARTIFACT_DIR",
                str(Path.home() / ".semibot" / "artifacts" / "browser"),
            )
        ).expanduser()
        self.artifact_dir.mkdir(parents=True, exist_ok=True)

        self._sessions: dict[str, _BrowserSession] = {}
        self._lock = asyncio.Lock()
        self._load_runtime_config()

    @property
    def name(self) -> str:
        return "browser_automation"

    @property
    def description(self) -> str:
        return "Automate browser actions: open pages, click/type, extract text/links, and capture screenshots."

    @property
    def parameters(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "action": {
                    "type": "string",
                    "enum": [
                        "open",
                        "click",
                        "type",
                        "press",
                        "wait_for",
                        "extract_text",
                        "get_links",
                        "screenshot",
                        "get_html",
                        "status",
                        "close",
                    ],
                    "description": "Browser action to execute.",
                },
                "session_id": {
                    "type": "string",
                    "description": "Logical browser session identifier. Reuses page state across calls.",
                    "default": "default",
                },
                "url": {"type": "string", "description": "Target URL for open/wait_for(url)."},
                "selector": {"type": "string", "description": "CSS selector for click/type/extract/wait_for."},
                "text": {"type": "string", "description": "Text content used by type action."},
                "key": {"type": "string", "description": "Keyboard key for press action, e.g. Enter."},
                "timeout_ms": {"type": "integer", "description": "Action timeout in milliseconds."},
                "wait_until": {
                    "type": "string",
                    "enum": ["domcontentloaded", "load", "networkidle", "commit"],
                    "description": "Navigation readiness target for open action.",
                    "default": "domcontentloaded",
                },
                "duration_ms": {"type": "integer", "description": "Sleep duration for wait_for without selector/url."},
                "full_page": {"type": "boolean", "description": "Capture full page in screenshot.", "default": True},
                "path": {
                    "type": "string",
                    "description": "Output path for screenshot. Relative paths are under ~/.semibot/artifacts/browser.",
                },
                "max_chars": {"type": "integer", "description": "Maximum characters returned by extract/get_html."},
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
                self.default_timeout_ms = int(timeout)

            if "headless" in config:
                self.default_headless = _to_bool(config.get("headless"), self.default_headless)

            browser_type = str(config.get("browserType") or "").strip().lower()
            if browser_type in _SUPPORTED_BROWSERS:
                self.browser_type = browser_type

            if "allowLocalhost" in config:
                self.allow_localhost = _to_bool(config.get("allowLocalhost"), self.allow_localhost)

            max_text_length = config.get("maxTextLength")
            if isinstance(max_text_length, int) and max_text_length >= 100:
                self.max_text_length = max_text_length

            allowed_domains = _parse_domain_rules(config.get("allowedDomains"))
            blocked_domains = _parse_domain_rules(config.get("blockedDomains"))
            if allowed_domains:
                self.allowed_domains = allowed_domains
            if blocked_domains:
                self.blocked_domains = blocked_domains
        except Exception:
            return

    def _resolve_timeout_ms(self, value: Any) -> int:
        if isinstance(value, int) and value > 0:
            return value
        if isinstance(value, float) and value > 0:
            return int(value)
        return max(1000, self.default_timeout_ms)

    def _resolve_max_chars(self, value: Any) -> int:
        if isinstance(value, int) and value > 0:
            return value
        return max(500, self.max_text_length)

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

    def _resolve_screenshot_path(self, session_id: str, provided_path: str | None) -> Path:
        if provided_path and provided_path.strip():
            resolved = Path(provided_path.strip()).expanduser()
            if not resolved.is_absolute():
                resolved = self.artifact_dir / resolved
        else:
            filename = f"{session_id}-{int(time.time() * 1000)}.png"
            resolved = self.artifact_dir / filename
        resolved.parent.mkdir(parents=True, exist_ok=True)
        return resolved

    async def _ensure_session(self, session_id: str) -> _BrowserSession:
        async with self._lock:
            existing = self._sessions.get(session_id)
            if existing is not None:
                existing.last_used_at = time.time()
                return existing

            try:
                from playwright.async_api import async_playwright
            except ImportError as exc:
                raise RuntimeError(
                    "Playwright is not installed. Run `python -m pip install playwright` and "
                    "`python -m playwright install chromium`."
                ) from exc

            playwright = await async_playwright().start()
            browser_factory = getattr(playwright, self.browser_type, None)
            if browser_factory is None:
                await playwright.stop()
                raise RuntimeError(f"Unsupported browserType: {self.browser_type}")

            browser = await browser_factory.launch(headless=self.default_headless)
            context = await browser.new_context()
            page = await context.new_page()

            now = time.time()
            session = _BrowserSession(
                playwright=playwright,
                browser=browser,
                context=context,
                page=page,
                created_at=now,
                last_used_at=now,
            )
            self._sessions[session_id] = session
            return session

    async def _close_session(self, session_id: str) -> bool:
        async with self._lock:
            session = self._sessions.pop(session_id, None)
        if session is None:
            return False

        try:
            await session.context.close()
        except Exception:
            pass
        try:
            await session.browser.close()
        except Exception:
            pass
        try:
            await session.playwright.stop()
        except Exception:
            pass
        return True

    async def execute(self, action: str | None = None, **kwargs: Any) -> ToolResult:
        self._load_runtime_config()

        action_name = (action or "").strip().lower()
        if not action_name:
            # Graceful fallback for planner/tool-call outputs missing explicit action.
            if kwargs.get("url"):
                action_name = "open"
            elif kwargs.get("selector") and kwargs.get("text") is not None:
                action_name = "type"
            elif kwargs.get("selector"):
                action_name = "click"
            elif kwargs.get("path"):
                action_name = "screenshot"
            else:
                return ToolResult.error_result(
                    "action is required (open/click/type/press/wait_for/extract_text/get_links/screenshot/get_html/status/close)"
                )

        alias_map = {
            "visit": "open",
            "navigate": "open",
            "goto": "open",
        }
        action_name = alias_map.get(action_name, action_name)
        session_id = str(kwargs.get("session_id") or "default").strip() or "default"
        timeout_ms = self._resolve_timeout_ms(kwargs.get("timeout_ms"))

        try:
            if action_name == "status":
                sessions = [
                    {
                        "session_id": sid,
                        "url": str(session.page.url),
                        "created_at": session.created_at,
                        "last_used_at": session.last_used_at,
                    }
                    for sid, session in self._sessions.items()
                ]
                return ToolResult.success_result(
                    {
                        "active_sessions": len(sessions),
                        "sessions": sessions,
                        "browser_type": self.browser_type,
                        "headless": self.default_headless,
                    }
                )

            if action_name == "close":
                closed = await self._close_session(session_id)
                return ToolResult.success_result({"session_id": session_id, "closed": closed})

            if action_name == "open":
                url = str(kwargs.get("url") or "").strip()
                if not url:
                    return ToolResult.error_result("url is required for action=open")
                valid, error = self._validate_url(url)
                if not valid:
                    return ToolResult.error_result(error or "Invalid URL")

            session = await self._ensure_session(session_id)
            session.last_used_at = time.time()
            page = session.page

            if action_name == "open":
                wait_until = str(kwargs.get("wait_until") or "domcontentloaded")
                response = await page.goto(url, wait_until=wait_until, timeout=timeout_ms)
                return ToolResult.success_result(
                    {
                        "session_id": session_id,
                        "url": page.url,
                        "title": await page.title(),
                        "status": response.status if response is not None else None,
                    }
                )

            if action_name == "click":
                selector = str(kwargs.get("selector") or "").strip()
                if not selector:
                    return ToolResult.error_result("selector is required for action=click")
                await page.click(selector, timeout=timeout_ms)
                return ToolResult.success_result({"session_id": session_id, "url": page.url, "clicked": selector})

            if action_name == "type":
                selector = str(kwargs.get("selector") or "").strip()
                text = str(kwargs.get("text") or "")
                if not selector:
                    return ToolResult.error_result("selector is required for action=type")
                await page.fill(selector, text, timeout=timeout_ms)
                return ToolResult.success_result({"session_id": session_id, "typed": selector, "length": len(text)})

            if action_name == "press":
                key = str(kwargs.get("key") or "").strip()
                selector = str(kwargs.get("selector") or "").strip()
                if not key:
                    return ToolResult.error_result("key is required for action=press")
                if selector:
                    await page.press(selector, key, timeout=timeout_ms)
                else:
                    await page.keyboard.press(key)
                return ToolResult.success_result({"session_id": session_id, "key": key, "selector": selector or None})

            if action_name == "wait_for":
                selector = str(kwargs.get("selector") or "").strip()
                url = str(kwargs.get("url") or "").strip()
                duration_raw = kwargs.get("duration_ms")
                if selector:
                    await page.wait_for_selector(selector, timeout=timeout_ms)
                    return ToolResult.success_result({"session_id": session_id, "waited_for": {"selector": selector}})
                if url:
                    await page.wait_for_url(url, timeout=timeout_ms)
                    return ToolResult.success_result({"session_id": session_id, "waited_for": {"url": url}})
                duration_ms = 0
                if isinstance(duration_raw, int) and duration_raw > 0:
                    duration_ms = duration_raw
                elif isinstance(duration_raw, float) and duration_raw > 0:
                    duration_ms = int(duration_raw)
                if duration_ms <= 0:
                    return ToolResult.error_result(
                        "wait_for requires selector, url, or duration_ms > 0"
                    )
                await asyncio.sleep(duration_ms / 1000.0)
                return ToolResult.success_result({"session_id": session_id, "waited_for": {"duration_ms": duration_ms}})

            if action_name == "extract_text":
                selector = str(kwargs.get("selector") or "").strip()
                max_chars = self._resolve_max_chars(kwargs.get("max_chars"))
                if selector:
                    await page.wait_for_selector(selector, timeout=timeout_ms)
                    text = await page.locator(selector).first.inner_text(timeout=timeout_ms)
                else:
                    text = await page.evaluate("() => document.body ? document.body.innerText : ''")
                normalized = str(text or "")
                return ToolResult.success_result(
                    {
                        "session_id": session_id,
                        "url": page.url,
                        "title": await page.title(),
                        "text": normalized[:max_chars],
                        "truncated": len(normalized) > max_chars,
                    }
                )

            if action_name == "get_links":
                links = await page.evaluate(
                    "() => Array.from(document.querySelectorAll('a[href]')).slice(0, 100)"
                    ".map((a) => ({text: (a.textContent || '').trim(), href: a.href}))"
                )
                return ToolResult.success_result(
                    {
                        "session_id": session_id,
                        "url": page.url,
                        "title": await page.title(),
                        "links": links if isinstance(links, list) else [],
                    }
                )

            if action_name == "screenshot":
                full_page = _to_bool(kwargs.get("full_page"), True)
                screenshot_path = self._resolve_screenshot_path(session_id, kwargs.get("path"))
                await page.screenshot(path=str(screenshot_path), full_page=full_page)
                size = screenshot_path.stat().st_size if screenshot_path.exists() else 0
                return ToolResult.success_result(
                    {
                        "session_id": session_id,
                        "url": page.url,
                        "path": str(screenshot_path),
                        "bytes": size,
                    }
                )

            if action_name == "get_html":
                selector = str(kwargs.get("selector") or "").strip()
                max_chars = self._resolve_max_chars(kwargs.get("max_chars"))
                if selector:
                    await page.wait_for_selector(selector, timeout=timeout_ms)
                    html = await page.locator(selector).first.inner_html(timeout=timeout_ms)
                else:
                    html = await page.content()
                normalized = str(html or "")
                return ToolResult.success_result(
                    {
                        "session_id": session_id,
                        "url": page.url,
                        "html": normalized[:max_chars],
                        "truncated": len(normalized) > max_chars,
                    }
                )

            return ToolResult.error_result(f"Unsupported action: {action_name}")
        except Exception as exc:
            return ToolResult.error_result(str(exc))
