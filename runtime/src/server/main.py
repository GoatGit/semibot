"""Uvicorn entrypoint for Semibot Event API."""

from __future__ import annotations

import json
import os

import uvicorn

from src.bootstrap import ensure_runtime_home
from src.server.api import create_app


def main() -> None:
    host = os.getenv("SEMIBOT_API_HOST", "127.0.0.1")
    port = int(os.getenv("SEMIBOT_API_PORT", "8765"))
    db_path = os.getenv("SEMIBOT_EVENTS_DB_PATH")
    rules_path = os.getenv("SEMIBOT_RULES_PATH")
    feishu_verify_token = os.getenv("SEMIBOT_FEISHU_VERIFY_TOKEN")
    feishu_webhook_url = os.getenv("SEMIBOT_FEISHU_WEBHOOK_URL")
    feishu_webhooks_json = os.getenv("SEMIBOT_FEISHU_WEBHOOKS_JSON")
    feishu_notify_event_types_raw = os.getenv("SEMIBOT_FEISHU_NOTIFY_EVENT_TYPES")
    feishu_templates_json = os.getenv("SEMIBOT_FEISHU_TEMPLATES_JSON")
    heartbeat_interval_raw = os.getenv("SEMIBOT_HEARTBEAT_INTERVAL_SECONDS")
    heartbeat_interval = None
    if heartbeat_interval_raw:
        try:
            heartbeat_interval = float(heartbeat_interval_raw)
        except ValueError:
            heartbeat_interval = None

    cron_jobs_raw = os.getenv("SEMIBOT_CRON_JOBS_JSON")
    cron_jobs = None
    if cron_jobs_raw:
        try:
            parsed = json.loads(cron_jobs_raw)
            if isinstance(parsed, list):
                cron_jobs = parsed
        except json.JSONDecodeError:
            cron_jobs = None

    feishu_webhook_urls = None
    if feishu_webhooks_json:
        try:
            parsed = json.loads(feishu_webhooks_json)
            if isinstance(parsed, dict):
                feishu_webhook_urls = {
                    str(key): str(value)
                    for key, value in parsed.items()
                    if isinstance(value, str) and value
                }
        except json.JSONDecodeError:
            feishu_webhook_urls = None

    feishu_notify_event_types = None
    if feishu_notify_event_types_raw:
        parsed = {
            item.strip()
            for item in feishu_notify_event_types_raw.split(",")
            if item.strip()
        }
        feishu_notify_event_types = parsed or None

    feishu_templates = None
    if feishu_templates_json:
        try:
            parsed = json.loads(feishu_templates_json)
            if isinstance(parsed, dict):
                normalized: dict[str, dict[str, str]] = {}
                for event_type, tpl in parsed.items():
                    if isinstance(event_type, str) and isinstance(tpl, dict):
                        title = tpl.get("title")
                        content = tpl.get("content")
                        if isinstance(title, str) or isinstance(content, str):
                            normalized[event_type] = {
                                "title": str(title or ""),
                                "content": str(content or ""),
                            }
                feishu_templates = normalized or None
        except json.JSONDecodeError:
            feishu_templates = None

    telegram_bot_token = os.getenv("SEMIBOT_TELEGRAM_BOT_TOKEN")
    telegram_default_chat_id = os.getenv("SEMIBOT_TELEGRAM_DEFAULT_CHAT_ID")
    telegram_webhook_secret = os.getenv("SEMIBOT_TELEGRAM_WEBHOOK_SECRET")
    telegram_notify_event_types_raw = os.getenv("SEMIBOT_TELEGRAM_NOTIFY_EVENT_TYPES")
    telegram_notify_event_types = None
    if telegram_notify_event_types_raw:
        parsed = {
            item.strip()
            for item in telegram_notify_event_types_raw.split(",")
            if item.strip()
        }
        telegram_notify_event_types = parsed or None

    ensure_runtime_home(db_path=db_path, rules_path=rules_path)

    app = create_app(
        db_path=db_path,
        rules_path=rules_path,
        heartbeat_interval_seconds=heartbeat_interval,
        cron_jobs=cron_jobs,
        feishu_verify_token=feishu_verify_token,
        feishu_webhook_url=feishu_webhook_url,
        feishu_webhook_urls=feishu_webhook_urls,
        feishu_notify_event_types=feishu_notify_event_types,
        feishu_templates=feishu_templates,
        telegram_bot_token=telegram_bot_token,
        telegram_default_chat_id=telegram_default_chat_id,
        telegram_webhook_secret=telegram_webhook_secret,
        telegram_notify_event_types=telegram_notify_event_types,
    )
    uvicorn.run(app, host=host, port=port, log_level="info")


if __name__ == "__main__":
    main()
