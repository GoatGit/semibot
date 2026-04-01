"""Gateway manager wiring adapters, policies, and notifier lifecycle."""

from __future__ import annotations

import asyncio
import json
import mimetypes
import os
import re
from collections.abc import Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import httpx

from src.events.event_engine import EventEngine
from src.events.models import Event
from src.gateway.channels.feishu.plugin import FeishuChannelPlugin
from src.gateway.channels.discord.plugin import DiscordChannelPlugin
from src.gateway.channels.imessage.plugin import IMessageChannelPlugin
from src.gateway.channels.registry import ChannelPluginRegistry
from src.gateway.channels.telegram.plugin import TelegramChannelPlugin
from src.gateway.channels.whatsapp.plugin import WhatsAppChannelPlugin
from src.gateway.channels.discord.notifier import DiscordNotifier, SendFn as DiscordSendFn
from src.gateway.channels.imessage.notifier import IMessageNotifier, SendFn as IMessageSendFn
from src.gateway.channels.whatsapp.notifier import WhatsAppNotifier
from src.gateway.channels.feishu.notifier import FeishuNotifier, SdkSendFn, SendFn
from src.gateway.channels.telegram.notifier import (
    SendDocumentFn as TelegramSendDocumentFn,
)
from src.gateway.channels.telegram.notifier import SendFn as TelegramSendFn
from src.gateway.channels.telegram.notifier import TelegramNotifier
from src.gateway.context_service import GatewayContextService
from src.gateway.gateway_approval_targeting import (
    build_approval_targeting_state,
    duplicate_approval_ids_for_state,
    resolve_target_ids_for_text_command,
)
from src.execution.runtime_approval_resume import gateway_resolve_approval_command
from src.gateway.parsers.approval_text import parse_approval_text_command
from src.server.config_store import RuntimeConfigStore


class GatewayManagerError(Exception):
    def __init__(self, detail: str, *, status_code: int = 400):
        super().__init__(detail)
        self.detail = detail
        self.status_code = status_code


@dataclass(slots=True)
class GatewayManager:
    config_store: RuntimeConfigStore
    gateway_context: GatewayContextService
    engine: EventEngine
    feishu_verify_token: str | None = None
    feishu_webhook_url: str | None = None
    feishu_webhook_urls: dict[str, str] | None = None
    feishu_notify_event_types: set[str] | None = None
    feishu_templates: dict[str, dict[str, str]] | None = None
    feishu_send_fn: SendFn | None = None
    feishu_sdk_send_fn: SdkSendFn | None = None
    telegram_bot_token: str | None = None
    telegram_default_chat_id: str | None = None
    telegram_webhook_secret: str | None = None
    telegram_notify_event_types: set[str] | None = None
    telegram_send_fn: TelegramSendFn | None = None
    telegram_send_document_fn: TelegramSendDocumentFn | None = None
    discord_send_fn: DiscordSendFn | None = None
    imessage_send_fn: IMessageSendFn | None = None
    channel_plugins: ChannelPluginRegistry = field(default_factory=ChannelPluginRegistry)

    def __post_init__(self) -> None:
        if not self.channel_plugins.providers():
            self.channel_plugins.register(FeishuChannelPlugin())
            self.channel_plugins.register(TelegramChannelPlugin())
            self.channel_plugins.register(DiscordChannelPlugin())
            self.channel_plugins.register(WhatsAppChannelPlugin())
            self.channel_plugins.register(IMessageChannelPlugin())

    @staticmethod
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

    def _get_gateway(self, provider: str) -> dict[str, Any] | None:
        try:
            return self.config_store.get_gateway_config(provider)
        except ValueError:
            return None

    def provider_config(self, provider: str) -> dict[str, Any]:
        item = self._get_gateway(provider) or {}
        config = item.get("config")
        return config if isinstance(config, dict) else {}

    @staticmethod
    def _normalized_agent_id(value: Any) -> str | None:
        if not isinstance(value, str):
            return None
        agent_id = value.strip()
        return agent_id or None

    @classmethod
    def _parse_bot_bindings(cls, provider: str, value: Any) -> dict[str, str]:
        bindings: dict[str, str] = {}
        if isinstance(value, dict):
            for key, agent in value.items():
                bot_key = str(key).strip()
                agent_id = cls._normalized_agent_id(agent)
                if bot_key and agent_id:
                    normalized_key = bot_key if ":" in bot_key else f"{provider}:{bot_key}"
                    bindings[normalized_key] = agent_id
            return bindings
        if isinstance(value, list):
            for item in value:
                if not isinstance(item, dict):
                    continue
                bot_id = str(item.get("botId") or item.get("bot_id") or "").strip()
                agent_id = cls._normalized_agent_id(item.get("agentId") or item.get("agent_id"))
                enabled = cls._to_bool(item.get("enabled"), True)
                if bot_id and agent_id and enabled:
                    bindings[f"{provider}:{bot_id}"] = agent_id
        return bindings

    @staticmethod
    def _normalized_string_list(value: Any) -> list[str]:
        raw_items: list[Any] = []
        if isinstance(value, list):
            raw_items = value
        elif isinstance(value, str):
            raw_items = value.split(",")
        values: list[str] = []
        for item in raw_items:
            text = str(item or "").strip()
            if text and text not in values:
                values.append(text)
        return values

    @classmethod
    def _normalize_gateway_config_patch(cls, provider: str | None, value: Any) -> dict[str, Any]:
        config = dict(value) if isinstance(value, dict) else {}
        normalized = dict(config)
        provider_name = str(provider or "").strip().lower()

        for legacy_key in ("defaultChatId", "allowedChatIds", "chatBindings", "default_chat_id", "allowed_chat_ids", "chat_bindings"):
            normalized.pop(legacy_key, None)

        bot_bindings_raw: Any | None = None
        if "botBindings" in normalized:
            bot_bindings_raw = normalized.get("botBindings")
        elif "bot_bindings" in normalized:
            bot_bindings_raw = normalized.pop("bot_bindings")
        if bot_bindings_raw is not None:
            bindings_map = cls._parse_bot_bindings(provider_name, bot_bindings_raw)
            normalized["botBindings"] = [
                {"botId": bot_key.split(":", 1)[1] if ":" in bot_key else bot_key, "agentId": agent_id}
                for bot_key, agent_id in bindings_map.items()
            ]

        if "notifyEventTypes" in normalized or "notify_event_types" in normalized:
            notify_raw = normalized.get("notifyEventTypes")
            if notify_raw is None and "notify_event_types" in normalized:
                notify_raw = normalized.pop("notify_event_types")
            normalized["notifyEventTypes"] = cls._normalized_string_list(notify_raw)

        return normalized

    def _gateway_agent_id(
        self,
        provider: str,
        instance: dict[str, Any] | None = None,
        *,
        event_payload: Mapping[str, Any] | None = None,
    ) -> str:
        cfg = instance.get("config") if isinstance(instance, dict) else self.provider_config(provider)
        cfg_map = cfg if isinstance(cfg, dict) else {}
        bot_id = str((event_payload or {}).get("bot_id") or (event_payload or {}).get("app_id") or "").strip()
        if bot_id:
            bindings = self._parse_bot_bindings(provider, cfg_map.get("botBindings"))
            match_key = f"{provider}:{bot_id}"
            if match_key in bindings:
                return bindings[match_key]
        resolved = (
            self._normalized_agent_id(cfg_map.get("agentId"))
            or self._normalized_agent_id(cfg_map.get("defaultAgentId"))
            or "semibot"
        )
        return resolved

    def list_provider_instances(self, provider: str, *, active_only: bool = False) -> list[dict[str, Any]]:
        try:
            items = self.config_store.list_gateway_instances(provider=provider)
        except ValueError:
            return []
        if not active_only:
            return items
        return [item for item in items if bool(item.get("is_active"))]

    def _get_instance(self, instance_id: str) -> dict[str, Any] | None:
        return self.config_store.get_gateway_instance(instance_id)

    async def _aget_instance(self, instance_id: str) -> dict[str, Any] | None:
        return await self.config_store.aget_gateway_instance(instance_id)

    async def alist_provider_instances(self, provider: str, *, active_only: bool = False) -> list[dict[str, Any]]:
        try:
            items = await self.config_store.alist_gateway_instances(provider=provider)
        except ValueError:
            return []
        if not active_only:
            return items
        return [item for item in items if bool(item.get("is_active"))]

    async def aprovider_active(self, provider: str) -> bool:
        if await self.alist_provider_instances(provider, active_only=True):
            return True
        item = await self.config_store.aget_gateway_config(provider)
        if item and item.get("is_active"):
            return True
        if provider == "feishu":
            return bool(self.feishu_verify_token or self.feishu_webhook_url or self.feishu_webhook_urls)
        if provider == "telegram":
            return bool(self.telegram_bot_token)
        return False

    async def _aiter_channel_targets(self, provider: str) -> list[dict[str, Any]]:
        plugin = self.channel_plugin(provider)
        if not plugin:
            return []
        items = await self.alist_provider_instances(provider, active_only=True)
        if not items and await self.aprovider_active(provider):
            return [{}]
        return items

    def provider_active(self, provider: str) -> bool:
        if self.list_provider_instances(provider, active_only=True):
            return True
        item = self._get_gateway(provider)
        if item and item.get("is_active"):
            return True
        if provider == "feishu":
            return bool(self.feishu_verify_token or self.feishu_webhook_url or self.feishu_webhook_urls)
        if provider == "telegram":
            return bool(self.telegram_bot_token)
        return False

    def channel_plugin(self, provider: str):
        return self.channel_plugins.get(provider)

    def _iter_channel_targets(self, provider: str) -> list[dict[str, Any]]:
        plugin = self.channel_plugin(provider)
        if not plugin:
            return []
        return plugin.list_active_instances(self)

    @staticmethod
    def _telegram_bot_id(token: str | None) -> str | None:
        value = str(token or "").strip()
        if ":" not in value:
            return None
        prefix = value.split(":", 1)[0].strip()
        return prefix or None

    @staticmethod
    def _parse_gateway_id(value: str | None) -> tuple[str | None, str | None, str | None]:
        raw = str(value or "").strip()
        if not raw:
            return None, None, None
        parts = raw.split(":", 2)
        if len(parts) == 2:
            provider = parts[0].strip().lower() or None
            instance_id = parts[1].strip() or None
            return provider, instance_id, None
        if len(parts) != 3:
            return None, None, None
        provider = parts[0].strip().lower() or None
        instance_id = parts[1].strip() or None
        chat_id = parts[2].strip() or None
        return provider, instance_id, chat_id

    @staticmethod
    def _sanitize_path_component(value: str) -> str:
        cleaned = re.sub(r"[^a-zA-Z0-9._-]+", "_", value.strip())
        return cleaned.strip("._") or "unknown"

    @staticmethod
    def _safe_filename(name: str, *, fallback: str) -> str:
        raw = str(name or "").strip()
        candidate = raw.split("/")[-1].split("\\")[-1]
        candidate = re.sub(r"[^a-zA-Z0-9._-]+", "_", candidate)
        candidate = candidate.strip("._")
        return candidate or fallback

    @staticmethod
    def _guess_extension(mime_type: str | None, *, fallback: str = ".bin") -> str:
        mime = str(mime_type or "").strip().lower()
        if not mime:
            return fallback
        guessed = mimetypes.guess_extension(mime)
        if isinstance(guessed, str) and guessed:
            return guessed
        return fallback

    @staticmethod
    def _telegram_inbound_max_bytes() -> int:
        raw = str(os.getenv("SEMIBOT_TELEGRAM_INBOUND_MAX_FILE_BYTES", "")).strip()
        if raw.isdigit():
            return max(1, int(raw))
        return 20 * 1024 * 1024

    @staticmethod
    def _telegram_inbound_root_dir() -> Path:
        base = str(os.getenv("SEMIBOT_TELEGRAM_INBOUND_DIR", "~/.semibot/inbound/telegram")).strip()
        return Path(base).expanduser()

    @staticmethod
    def _discord_inbound_max_bytes() -> int:
        raw = str(os.getenv("SEMIBOT_DISCORD_INBOUND_MAX_FILE_BYTES", "")).strip()
        if raw.isdigit():
            return max(1, int(raw))
        return 20 * 1024 * 1024

    @staticmethod
    def _discord_inbound_root_dir() -> Path:
        base = str(os.getenv("SEMIBOT_DISCORD_INBOUND_DIR", "~/.semibot/inbound/discord")).strip()
        return Path(base).expanduser()

    async def _send_feishu_via_node_sdk(
        self,
        app_id: str,
        app_secret: str,
        receive_id_type: str,
        receive_id: str,
        text: str,
        domain: str | None = None,
    ) -> bool:
        if self.feishu_sdk_send_fn:
            return await self.feishu_sdk_send_fn(
                app_id,
                app_secret,
                receive_id_type,
                receive_id,
                text,
                domain,
            )

        runtime_root = Path(__file__).resolve().parents[2]
        script_path = runtime_root / "scripts" / "feishu_sdk_send.mjs"
        if not script_path.exists():
            raise RuntimeError(f"missing_feishu_sdk_script: {script_path}")

        node_bin = str(os.getenv("SEMIBOT_NODE_BIN", "node")).strip() or "node"
        cmd = [
            node_bin,
            str(script_path),
            "--app-id",
            app_id,
            "--app-secret",
            app_secret,
            "--receive-id-type",
            receive_id_type,
            "--receive-id",
            receive_id,
            "--text",
            text,
        ]
        if domain:
            cmd.extend(["--domain", domain])

        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await proc.communicate()
        out_text = stdout.decode("utf-8", errors="ignore").strip()
        err_text = stderr.decode("utf-8", errors="ignore").strip()
        if proc.returncode != 0:
            raise RuntimeError(f"feishu_sdk_send_failed: {err_text or out_text or proc.returncode}")
        if not out_text:
            return False
        # Feishu Node SDK may print info logs (e.g. "[info]: ['client ready']") to stdout
        # before the final JSON payload. Parse the last valid JSON line defensively.
        json_candidate = out_text
        if "\n" in out_text:
            lines = [line.strip() for line in out_text.splitlines() if line.strip()]
            for line in reversed(lines):
                if line.startswith("{") and line.endswith("}"):
                    json_candidate = line
                    break
        try:
            parsed = json.loads(json_candidate)
        except json.JSONDecodeError as exc:
            raise RuntimeError(f"feishu_sdk_invalid_json: {out_text}") from exc
        return bool(parsed.get("ok"))

    async def _telegram_get_file_path(self, *, token: str, file_id: str) -> str:
        endpoint = f"https://api.telegram.org/bot{token}/getFile"
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.get(endpoint, params={"file_id": file_id})
            resp.raise_for_status()
            payload = resp.json()
        if not isinstance(payload, dict) or payload.get("ok") is not True:
            raise RuntimeError("telegram_get_file_failed")
        result = payload.get("result")
        if not isinstance(result, dict):
            raise RuntimeError("telegram_get_file_invalid_result")
        file_path = str(result.get("file_path") or "").strip()
        if not file_path:
            raise RuntimeError("telegram_file_path_missing")
        return file_path

    async def _telegram_download_content(self, *, token: str, file_path: str) -> bytes:
        url = f"https://api.telegram.org/file/bot{token}/{file_path.lstrip('/')}"
        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.get(url)
            resp.raise_for_status()
            return bytes(resp.content)

    async def _download_http_content(self, *, url: str, max_bytes: int, timeout: float = 30.0) -> bytes:
        async with httpx.AsyncClient(timeout=timeout, follow_redirects=True) as client:
            resp = await client.get(url)
            resp.raise_for_status()
            content = bytes(resp.content)
        if len(content) > max_bytes:
            raise RuntimeError(f"downloaded_file_too_large:{len(content)}>{max_bytes}")
        return content

    def build_feishu_notifier(self, instance: dict[str, Any] | None = None) -> FeishuNotifier | None:
        cfg = instance.get("config") if isinstance(instance, dict) else self.provider_config("feishu")
        cfg = cfg if isinstance(cfg, dict) else {}
        webhook_url = str(cfg.get("webhookUrl") or "").strip() or self.feishu_webhook_url
        webhook_channels = cfg.get("webhookChannels")
        webhook_urls = (
            {str(k): str(v) for k, v in webhook_channels.items() if isinstance(v, str) and v}
            if isinstance(webhook_channels, dict)
            else (self.feishu_webhook_urls or {})
        )

        raw_event_types = cfg.get("notifyEventTypes")
        subscribed = self.feishu_notify_event_types
        if isinstance(raw_event_types, list):
            parsed = {str(item).strip() for item in raw_event_types if str(item).strip()}
            subscribed = parsed or None

        templates_cfg = cfg.get("templates")
        templates = templates_cfg if isinstance(templates_cfg, dict) else self.feishu_templates
        sdk_enabled = self._to_bool(cfg.get("sdkEnabled"), False)
        sdk_app_id = str(cfg.get("appId") or "").strip()
        sdk_app_secret = str(cfg.get("appSecret") or "").strip()
        sdk_default_receive_id = str(cfg.get("defaultReceiveId") or "").strip()
        sdk_receive_id_type = str(cfg.get("receiveIdType") or "chat_id").strip().lower()
        sdk_domain = str(cfg.get("sdkDomain") or "").strip() or None

        if not webhook_url and not webhook_urls and not (sdk_enabled and sdk_app_id and sdk_app_secret):
            return None
        return FeishuNotifier(
            webhook_url=webhook_url,
            webhook_urls=webhook_urls,
            subscribed_event_types=subscribed,
            templates=templates if isinstance(templates, dict) else None,
            send_fn=self.feishu_send_fn,
            sdk_enabled=sdk_enabled,
            sdk_app_id=sdk_app_id or None,
            sdk_app_secret=sdk_app_secret or None,
            sdk_default_receive_id=sdk_default_receive_id or None,
            sdk_receive_id_type=sdk_receive_id_type or "chat_id",
            sdk_domain=sdk_domain,
            sdk_send_fn=self._send_feishu_via_node_sdk,
        )

    def build_telegram_notifier(self, instance: dict[str, Any] | None = None) -> TelegramNotifier | None:
        cfg = instance.get("config") if isinstance(instance, dict) else self.provider_config("telegram")
        cfg = cfg if isinstance(cfg, dict) else {}
        token = str(cfg.get("botToken") or "").strip() or self.telegram_bot_token
        default_chat_id = str(self.telegram_default_chat_id or "").strip()
        if not token:
            return None
        raw_event_types = cfg.get("notifyEventTypes")
        subscribed = self.telegram_notify_event_types
        if isinstance(raw_event_types, list):
            parsed = {str(item).strip() for item in raw_event_types if str(item).strip()}
            subscribed = parsed or None
        parse_mode_raw = cfg.get("parseMode")
        parse_mode = str(parse_mode_raw).strip() if isinstance(parse_mode_raw, str) else ""
        if parse_mode.lower() in {"none", "off", "disabled", "plain"}:
            parse_mode = ""
        disable_link_preview = self._to_bool(cfg.get("disableLinkPreview"), False)
        return TelegramNotifier(
            bot_token=token,
            default_chat_id=default_chat_id or None,
            subscribed_event_types=subscribed,
            parse_mode=parse_mode or None,
            disable_link_preview=disable_link_preview,
            send_fn=self.telegram_send_fn,
            send_document_fn=self.telegram_send_document_fn,
        )

    def build_discord_notifier(self, instance: dict[str, Any] | None = None) -> DiscordNotifier | None:
        cfg = instance.get("config") if isinstance(instance, dict) else self.provider_config("discord")
        cfg = cfg if isinstance(cfg, dict) else {}
        token = str(cfg.get("botToken") or "").strip()
        default_channel_id = str(cfg.get("defaultChannelId") or cfg.get("channelId") or "").strip()
        raw_event_types = cfg.get("notifyEventTypes")
        subscribed = None
        if isinstance(raw_event_types, list):
            parsed = {str(item).strip() for item in raw_event_types if str(item).strip()}
            subscribed = parsed or None
        if not token:
            return None
        return DiscordNotifier(
            bot_token=token,
            default_channel_id=default_channel_id or None,
            subscribed_event_types=subscribed,
            send_fn=self.discord_send_fn,
        )

    def build_whatsapp_notifier(self, instance: dict[str, Any] | None = None) -> WhatsAppNotifier | None:
        cfg = instance.get("config") if isinstance(instance, dict) else self.provider_config("whatsapp")
        cfg = cfg if isinstance(cfg, dict) else {}
        raw_event_types = cfg.get("notifyEventTypes")
        subscribed = None
        if isinstance(raw_event_types, list):
            parsed = {str(item).strip() for item in raw_event_types if str(item).strip()}
            subscribed = parsed or None
        return WhatsAppNotifier(
            instance_id=str(instance.get("id") or "").strip() if isinstance(instance, dict) else None,
            session_name=str(cfg.get("sessionName") or "").strip() or None,
            default_chat_id=str(cfg.get("defaultPhone") or "").strip() or None,
            linked_phone=str(cfg.get("linkedPhone") or "").strip() or None,
            subscribed_event_types=subscribed,
        )

    def build_imessage_notifier(self, instance: dict[str, Any] | None = None) -> IMessageNotifier | None:
        cfg = instance.get("config") if isinstance(instance, dict) else self.provider_config("imessage")
        cfg = cfg if isinstance(cfg, dict) else {}
        raw_event_types = cfg.get("notifyEventTypes")
        subscribed = None
        if isinstance(raw_event_types, list):
            parsed = {str(item).strip() for item in raw_event_types if str(item).strip()}
            subscribed = parsed or None
        return IMessageNotifier(
            bridge_url=str(cfg.get("bridgeUrl") or "").strip() or None,
            default_handle=str(cfg.get("defaultHandle") or "").strip() or None,
            subscribed_event_types=subscribed,
            send_fn=self.imessage_send_fn,
        )

    async def handle_runtime_notify_payload(self, payload: dict[str, Any]) -> None:
        gateway_id = str(payload.get("gateway_id") or payload.get("gatewayId") or "").strip()
        target_provider, target_instance_id, target_chat_id = self._parse_gateway_id(gateway_id)
        providers = [target_provider] if target_provider else self.channel_plugins.providers()
        for provider in providers:
            plugin = self.channel_plugin(provider)
            if not plugin:
                continue
            for item in await self._aiter_channel_targets(provider):
                if not plugin.matches_gateway_target(
                    self,
                    item,
                    instance_id=target_instance_id,
                    chat_id=target_chat_id,
                ):
                    continue
                send_payload = plugin.apply_target_overrides(dict(payload), chat_id=target_chat_id)
                await plugin.send_notify_payload(self, item, send_payload)

    async def handle_engine_event(self, event: Event) -> None:
        for provider in self.channel_plugins.providers():
            plugin = self.channel_plugin(provider)
            if not plugin:
                continue
            for item in await self._aiter_channel_targets(provider):
                await plugin.handle_event(self, item, event)

    def _mask_gateway_config(self, provider: str, config: dict[str, Any]) -> dict[str, Any]:
        masked = dict(config)
        sensitive_fields = {
            "feishu": {"verifyToken", "encryptKey", "appSecret"},
            "telegram": {"botToken", "webhookSecret"},
            "discord": {"botToken"},
            "whatsapp": {"sessionSecret", "accessToken"},
            "imessage": {"apiToken"},
        }
        for key in sensitive_fields.get(provider, set()):
            value = masked.get(key)
            if isinstance(value, str) and value:
                masked[key] = "***"
        return masked

    def _gateway_status(self, provider: str, is_active: bool, config: dict[str, Any]) -> str:
        if not is_active:
            return "disabled"
        if provider == "telegram":
            token = str(config.get("botToken") or "").strip() or str(self.telegram_bot_token or "").strip()
            return "ready" if token else "not_configured"
        if provider == "feishu":
            verify_token = str(config.get("verifyToken") or "").strip() or str(self.feishu_verify_token or "").strip()
            webhook_url = str(config.get("webhookUrl") or "").strip() or str(self.feishu_webhook_url or "").strip()
            webhook_channels = config.get("webhookChannels")
            has_channel = isinstance(webhook_channels, dict) and any(
                isinstance(v, str) and v.strip() for v in webhook_channels.values()
            )
            sdk_enabled = self._to_bool(config.get("sdkEnabled"), False)
            sdk_app_id = str(config.get("appId") or "").strip()
            sdk_app_secret = str(config.get("appSecret") or "").strip()
            sdk_ready = sdk_enabled and sdk_app_id and sdk_app_secret
            return "ready" if (verify_token or webhook_url or has_channel or sdk_ready) else "not_configured"
        if provider == "discord":
            token = str(config.get("botToken") or "").strip()
            return "ready" if token else "not_configured"
        if provider == "whatsapp":
            session_name = str(config.get("sessionName") or "").strip()
            linked_phone = str(config.get("linkedPhone") or "").strip()
            default_phone = str(config.get("defaultPhone") or "").strip()
            return "ready" if (session_name or linked_phone or default_phone) else "not_configured"
        if provider == "imessage":
            bridge_url = str(config.get("bridgeUrl") or "").strip()
            account = str(config.get("defaultHandle") or "").strip()
            return "ready" if (bridge_url or account) else "not_configured"
        return "ready"

    def serialize_gateway_item(self, item: dict[str, Any]) -> dict[str, Any]:
        provider = str(item.get("provider") or "")
        config = item.get("config")
        config_map = config if isinstance(config, dict) else {}
        addressing_policy = (
            config_map.get("addressingPolicy")
            if isinstance(config_map.get("addressingPolicy"), dict)
            else None
        )
        proactive_policy = (
            config_map.get("proactivePolicy")
            if isinstance(config_map.get("proactivePolicy"), dict)
            else None
        )
        context_policy = (
            config_map.get("contextPolicy")
            if isinstance(config_map.get("contextPolicy"), dict)
            else None
        )
        is_active = bool(item.get("is_active"))
        return {
            "id": item.get("id"),
            "instanceKey": item.get("instance_key"),
            "provider": provider,
            "displayName": item.get("display_name") or provider,
            "isDefault": bool(item.get("is_default")),
            "isActive": is_active,
            "mode": item.get("mode") or "webhook",
            "riskLevel": item.get("risk_level") or "high",
            "requiresApproval": bool(item.get("requires_approval")),
            "status": self._gateway_status(provider, is_active, config_map),
            "config": self._mask_gateway_config(provider, config_map),
            "addressingPolicy": addressing_policy,
            "proactivePolicy": proactive_policy,
            "contextPolicy": context_policy,
            "updatedAt": item.get("updated_at"),
        }

    def _payload_to_gateway_patch(self, payload: dict[str, Any]) -> dict[str, Any]:
        patch: dict[str, Any] = {}
        if "displayName" in payload:
            patch["display_name"] = payload.get("displayName")
        if "display_name" in payload:
            patch["display_name"] = payload.get("display_name")
        if "isActive" in payload or "is_active" in payload:
            patch["is_active"] = self._to_bool(payload.get("isActive", payload.get("is_active")), False)
        if "isDefault" in payload or "is_default" in payload:
            patch["is_default"] = self._to_bool(payload.get("isDefault", payload.get("is_default")), False)
        if "mode" in payload:
            patch["mode"] = payload.get("mode")
        if "riskLevel" in payload or "risk_level" in payload:
            patch["risk_level"] = payload.get("riskLevel", payload.get("risk_level"))
        if "requiresApproval" in payload or "requires_approval" in payload:
            patch["requires_approval"] = self._to_bool(
                payload.get("requiresApproval", payload.get("requires_approval")),
                False,
            )

        merged_config: dict[str, Any] = {}
        config_payload = payload.get("config")
        if isinstance(config_payload, dict):
            merged_config.update(config_payload)
        for key in ("addressingPolicy", "proactivePolicy", "contextPolicy"):
            value = payload.get(key)
            if isinstance(value, dict):
                merged_config[key] = value
        if merged_config:
            patch["config"] = merged_config

        clear_fields = payload.get("clearFields", payload.get("clear_fields"))
        if isinstance(clear_fields, list):
            patch["clear_fields"] = [str(item) for item in clear_fields if isinstance(item, str)]
        return patch

    def list_gateway_configs(self) -> list[dict[str, Any]]:
        items = self.config_store.list_gateway_configs()
        return [self.serialize_gateway_item(item) for item in items]

    def list_gateway_instances(self, provider: str | None = None) -> list[dict[str, Any]]:
        try:
            items = self.config_store.list_gateway_instances(provider=provider)
        except ValueError:
            raise GatewayManagerError("unsupported_gateway_provider") from None
        return [self.serialize_gateway_item(item) for item in items]

    def get_gateway_instance(self, instance_id: str) -> dict[str, Any]:
        item = self._get_instance(instance_id)
        if not item:
            raise GatewayManagerError("gateway_instance_not_found", status_code=404)
        return self.serialize_gateway_item(item)

    def create_gateway_instance(self, payload: dict[str, Any]) -> dict[str, Any]:
        provider = payload.get("provider")
        if not isinstance(provider, str) or not provider.strip():
            raise GatewayManagerError("provider_required")
        patch = self._payload_to_gateway_patch(payload)
        if isinstance(patch.get("config"), dict):
            patch["config"] = self._normalize_gateway_config_patch(provider, patch.get("config"))
        patch["provider"] = provider
        if "instanceKey" in payload:
            patch["instance_key"] = payload.get("instanceKey")
        if "instance_key" in payload:
            patch["instance_key"] = payload.get("instance_key")
        try:
            item = self.config_store.create_gateway_instance(patch)
        except ValueError as exc:
            raise GatewayManagerError(str(exc)) from exc
        return self.serialize_gateway_item(item)

    def update_gateway_instance(self, instance_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        patch = self._payload_to_gateway_patch(payload)
        existing = self._get_instance(instance_id)
        if not existing:
            raise GatewayManagerError("gateway_instance_not_found", status_code=404)
        if isinstance(patch.get("config"), dict):
            patch["config"] = self._normalize_gateway_config_patch(existing.get("provider"), patch.get("config"))
        try:
            updated = self.config_store.update_gateway_instance(instance_id, patch)
        except ValueError:
            raise GatewayManagerError("unsupported_gateway_provider") from None
        if not updated:
            raise GatewayManagerError("gateway_instance_not_found", status_code=404)
        return self.serialize_gateway_item(updated)

    def delete_gateway_instance(self, instance_id: str) -> dict[str, Any]:
        deleted = self.config_store.soft_delete_gateway_instance(instance_id)
        if not deleted:
            raise GatewayManagerError("gateway_instance_not_found", status_code=404)
        return {"deleted": True}

    def batch_gateway_instances(self, payload: dict[str, Any]) -> dict[str, Any]:
        action = str(payload.get("action") or "").strip().lower()
        if action not in {"enable", "disable", "delete"}:
            raise GatewayManagerError("unsupported_batch_action")

        ids_raw = payload.get("instanceIds", payload.get("instance_ids"))
        if not isinstance(ids_raw, list):
            raise GatewayManagerError("instance_ids_required")
        requested: list[str] = []
        for item in ids_raw:
            value = str(item).strip() if isinstance(item, str) else ""
            if value and value not in requested:
                requested.append(value)
        if not requested:
            raise GatewayManagerError("instance_ids_required")

        provider = payload.get("provider")
        if provider is not None and not isinstance(provider, str):
            raise GatewayManagerError("unsupported_gateway_provider")
        provider_filter = str(provider).strip() if isinstance(provider, str) and provider.strip() else None
        try:
            all_items = self.config_store.list_gateway_instances(provider=provider_filter)
        except ValueError:
            raise GatewayManagerError("unsupported_gateway_provider") from None
        by_id = {
            str(item.get("id")): item
            for item in all_items
            if isinstance(item, dict) and isinstance(item.get("id"), str)
        }
        ignore_missing = self._to_bool(payload.get("ignoreMissing", payload.get("ignore_missing")), False)
        missing = [instance_id for instance_id in requested if instance_id not in by_id]
        if missing and not ignore_missing:
            raise GatewayManagerError("gateway_instance_not_found", status_code=404)
        targets = [instance_id for instance_id in requested if instance_id in by_id]

        changed: list[str] = []
        unchanged: list[str] = []
        blocked: list[dict[str, str]] = []
        failed: list[dict[str, str]] = []
        for instance_id in targets:
            current = by_id.get(instance_id) or {}
            try:
                if action in {"enable", "disable"}:
                    expected = action == "enable"
                    if bool(current.get("is_active")) == expected:
                        unchanged.append(instance_id)
                        continue
                    updated = self.config_store.update_gateway_instance(instance_id, {"is_active": expected})
                    if updated:
                        changed.append(instance_id)
                    else:
                        failed.append({"instanceId": instance_id, "error": "update_failed"})
                    continue

                if bool(current.get("is_default")):
                    blocked.append({"instanceId": instance_id, "reason": "default_instance"})
                    continue
                deleted = self.config_store.soft_delete_gateway_instance(instance_id)
                if deleted:
                    changed.append(instance_id)
                else:
                    failed.append({"instanceId": instance_id, "error": "delete_failed"})
            except Exception as exc:
                failed.append({"instanceId": instance_id, "error": str(exc)})

        return {
            "action": action,
            "requested": requested,
            "targets": targets,
            "changed": changed,
            "unchanged": unchanged,
            "blocked": blocked,
            "missing": missing,
            "failed": failed,
        }

    def get_gateway_config(self, provider: str) -> dict[str, Any]:
        try:
            item = self.config_store.get_gateway_config(provider)
        except ValueError:
            raise GatewayManagerError("unsupported_gateway_provider") from None
        if not item:
            raise GatewayManagerError("gateway_not_found", status_code=404)
        return self.serialize_gateway_item(item)

    def upsert_gateway_config(self, provider: str, payload: dict[str, Any]) -> dict[str, Any]:
        patch = self._payload_to_gateway_patch(payload)
        if isinstance(patch.get("config"), dict):
            patch["config"] = self._normalize_gateway_config_patch(provider, patch.get("config"))

        try:
            item = self.config_store.upsert_gateway_config(provider, patch)
        except ValueError:
            raise GatewayManagerError("unsupported_gateway_provider") from None
        return self.serialize_gateway_item(item)

    async def test_gateway(self, provider: str, payload: dict[str, Any]) -> dict[str, Any]:
        instance_id = str(payload.get("instance_id") or payload.get("instanceId") or "").strip() or None
        target_instance: dict[str, Any] | None = None
        if instance_id:
            target_instance = await self._aget_instance(instance_id)
            if not target_instance:
                raise GatewayManagerError("gateway_instance_not_found", status_code=404)
            if str(target_instance.get("provider")) != provider:
                raise GatewayManagerError("gateway_instance_provider_mismatch")
        plugin = self.channel_plugin(provider)
        if not plugin:
            raise GatewayManagerError("unsupported_gateway_provider")
        return await plugin.test_connection(self, target_instance, payload)

    @staticmethod
    def _legacy_debug_payload(item: dict[str, Any]) -> dict[str, Any] | None:
        if not (
            item.get("active_runtime_session_id")
            or item.get("active_runtime_forked_from_session_id")
        ):
            return None
        return {
            "active_runtime_session_id": item.get("active_runtime_session_id"),
            "active_runtime_session_status": item.get("active_runtime_session_status") or "idle",
            "active_runtime_forked_from_session_id": item.get("active_runtime_forked_from_session_id"),
        }

    def list_gateway_conversations(self, *, provider: str | None = None, limit: int = 20) -> dict[str, Any]:
        self.gateway_context.store.archive_old_task_runs(retention_days=7)
        items = self.gateway_context.list_conversations(provider=provider, limit=limit)
        data = []
        for item in items:
            runs = self.gateway_context.list_task_runs(item["id"], limit=1)
            latest_run = None
            if runs:
                row = runs[0]
                latest_run = self._project_gateway_run(row)
            data.append({
                "conversation_id": item["id"],
                "provider": item["provider"],
                "gateway_key": item["gateway_key"],
                "instance_id": item.get("instance_id") or "",
                "bot_id": item.get("bot_id") or "",
                "chat_id": item.get("chat_id") or "",
                "main_context_id": item["main_context_id"],
                "legacy_debug": self._legacy_debug_payload(item),
                "latest_context_version": item["latest_context_version"],
                "status": item["status"],
                "updated_at": item["updated_at"],
                "latest_run": latest_run,
            })
        return {"data": data}

    def get_gateway_conversation(self, conversation_id: str) -> dict[str, Any]:
        self.gateway_context.store.archive_old_task_runs(retention_days=7)
        item = self.gateway_context.store.get_conversation(conversation_id)
        if not item:
            raise GatewayManagerError("gateway_conversation_not_found", status_code=404)
        runs = self.gateway_context.list_task_runs(conversation_id, limit=1)
        latest_run = None
        if runs:
            row = runs[0]
            latest_run = self._project_gateway_run(row)
        return {
            "data": {
                "conversation_id": item["id"],
                "provider": item["provider"],
                "gateway_key": item["gateway_key"],
                "instance_id": item.get("instance_id") or "",
                "bot_id": item.get("bot_id") or "",
                "chat_id": item.get("chat_id") or "",
                "main_context_id": item["main_context_id"],
                "legacy_debug": self._legacy_debug_payload(item),
                "latest_context_version": item["latest_context_version"],
                "status": item["status"],
                "updated_at": item["updated_at"],
                "latest_run": latest_run,
            }
        }

    def list_gateway_conversation_runs(self, conversation_id: str, *, limit: int = 100) -> dict[str, Any]:
        self.gateway_context.store.archive_old_task_runs(retention_days=7)
        rows = self.gateway_context.list_task_runs(conversation_id, limit=limit)
        return {"data": [self._project_gateway_run(row) for row in rows]}

    async def alist_gateway_conversations(self, *, provider: str | None = None, limit: int = 20) -> dict[str, Any]:
        await self.gateway_context.archive_old_executions(retention_days=7)
        items = await self.gateway_context.store.alist_conversations(provider=provider, limit=limit)
        conversation_ids = [item["id"] for item in items]
        latest_runs_map = await self.gateway_context.store.abatch_latest_task_run(conversation_ids)
        data = []
        for item in items:
            row = latest_runs_map.get(item["id"])
            latest_run = None
            if row:
                latest_run = self._project_gateway_run(row)
            data.append({
                "conversation_id": item["id"],
                "provider": item["provider"],
                "gateway_key": item["gateway_key"],
                "instance_id": item.get("instance_id") or "",
                "bot_id": item.get("bot_id") or "",
                "chat_id": item.get("chat_id") or "",
                "main_context_id": item["main_context_id"],
                "legacy_debug": self._legacy_debug_payload(item),
                "latest_context_version": item["latest_context_version"],
                "status": item["status"],
                "updated_at": item["updated_at"],
                "latest_run": latest_run,
            })
        return {"data": data}

    async def aget_gateway_conversation(self, conversation_id: str) -> dict[str, Any]:
        await self.gateway_context.archive_old_executions(retention_days=7)
        item = await self.gateway_context.store.aget_conversation(conversation_id)
        if not item:
            raise GatewayManagerError("gateway_conversation_not_found", status_code=404)
        runs = await self.gateway_context.store.alist_task_runs(conversation_id, limit=1)
        latest_run = None
        if runs:
            row = runs[0]
            latest_run = self._project_gateway_run(row)
        return {"data": {
            "conversation_id": item["id"],
            "provider": item["provider"],
            "gateway_key": item["gateway_key"],
            "instance_id": item.get("instance_id") or "",
            "bot_id": item.get("bot_id") or "",
            "chat_id": item.get("chat_id") or "",
            "main_context_id": item["main_context_id"],
            "legacy_debug": self._legacy_debug_payload(item),
            "latest_context_version": item["latest_context_version"],
            "status": item["status"],
            "updated_at": item["updated_at"],
            "latest_run": latest_run,
        }}

    async def alist_gateway_conversation_runs(self, conversation_id: str, *, limit: int = 100) -> dict[str, Any]:
        await self.gateway_context.archive_old_executions(retention_days=7)
        rows = await self.gateway_context.store.alist_task_runs(conversation_id, limit=limit)
        return {"data": [self._project_gateway_run(row) for row in rows]}

    @staticmethod
    def _project_gateway_run(row: dict[str, Any]) -> dict[str, Any]:
        result_metadata = row.get("result_metadata")
        metadata = result_metadata if isinstance(result_metadata, dict) else {}
        missing_capability = metadata.get("missing_capability")
        return {
            "run_id": row["id"],
            "runtime_session_id": row["runtime_session_id"],
            "snapshot_version": row["snapshot_version"],
            "status": row["status"],
            "result_summary": row["result_summary"],
            "result_metadata": metadata,
            "missing_capability": missing_capability if isinstance(missing_capability, dict) else None,
            "updated_at": row["updated_at"],
        }

    def get_gateway_conversation_context(self, conversation_id: str, *, limit: int = 200) -> dict[str, Any]:
        messages = self.gateway_context.list_context(conversation_id, limit=limit)
        return {
            "conversation_id": conversation_id,
            "messages": [
                {
                    "id": item["id"],
                    "version": item["context_version"],
                    "role": item["role"],
                    "content": item["content"],
                    "metadata": item["metadata"],
                    "created_at": item["created_at"],
                }
                for item in messages
            ],
        }

    @staticmethod
    def _approval_matches_subject(
        item: Any,
        subject: str | None,
        *,
        scope_ids: set[str] | None = None,
        provider: str | None = None,
        instance_id: str | None = None,
    ) -> bool:
        scope_ids = scope_ids or set()
        if not subject:
            if not scope_ids:
                return False
        context = item.context if isinstance(getattr(item, "context", None), dict) else {}
        approval_scope_id = str(context.get("approval_scope_id") or "").strip()
        if approval_scope_id and approval_scope_id in scope_ids:
            return True
        expected_provider = str(provider or "").strip()
        expected_instance_id = str(instance_id or "").strip()
        context_provider = str(context.get("provider") or "").strip()
        context_instance_id = str(context.get("instance_id") or "").strip()
        if expected_provider and context_provider and context_provider != expected_provider:
            return False
        if expected_instance_id and context_instance_id and context_instance_id != expected_instance_id:
            return False
        candidates = {
            str(context.get("session_id") or ""),
            str(context.get("subject") or ""),
            str(context.get("chat_id") or ""),
            str(context.get("thread_id") or ""),
        }
        if subject is not None and str(subject) in candidates:
            return True
        return False

    def _approval_scope_ids_from_trace_payload(self, trace_payload: dict[str, Any] | None) -> set[str]:
        if not isinstance(trace_payload, dict):
            return set()
        raw = trace_payload.get("approval_scope_ids")
        values = raw if isinstance(raw, list) else [raw] if isinstance(raw, str) else []
        return {str(item).strip() for item in values if str(item).strip()}

    @staticmethod
    def _trace_string(trace_payload: dict[str, Any] | None, *paths: str) -> str | None:
        if not isinstance(trace_payload, dict):
            return None
        for path in paths:
            current: Any = trace_payload
            for part in path.split("."):
                if not isinstance(current, dict):
                    current = None
                    break
                current = current.get(part)
            value = str(current or "").strip() if current is not None else ""
            if value:
                return value
        return None

    def _approval_action_event_ref(self, trace_payload: dict[str, Any] | None) -> str | None:
        return self._trace_string(
            trace_payload,
            "callback_query.id",
            "callback_query.inline_message_id",
            "header.event_id",
            "event.message.message_id",
            "callback_query.message.message_id",
            "open_message_id",
            "message_id",
            "telegram_update_id",
            "update_id",
            "trace_id",
            "action.value.trace_id",
        )

    def _approval_action_idempotency_key(
        self,
        *,
        source: str,
        action: str,
        subject: str | None,
        trace_payload: dict[str, Any] | None = None,
        approval_ids: list[str] | None = None,
        execution_id: str | None = None,
        scope_ids: set[str] | None = None,
    ) -> str | None:
        event_ref = self._approval_action_event_ref(trace_payload)
        target = ",".join(sorted(str(item).strip() for item in (approval_ids or []) if str(item).strip()))
        if not target:
            target = str(execution_id or "").strip()
        if not target and scope_ids:
            target = ",".join(sorted(str(item).strip() for item in scope_ids if str(item).strip()))
        if not target:
            target = str(subject or "").strip()
        if not event_ref and not target:
            return None
        parts = ["gateway", "approval_action", source.strip(), action.strip()]
        if event_ref:
            parts.append(event_ref)
        if target:
            parts.append(target)
        return ":".join(part for part in parts if part)

    async def _bound_execution_from_trace_payload(
        self,
        *,
        trace_payload: dict[str, Any] | None,
        subject: str | None,
    ) -> dict[str, Any] | None:
        if not isinstance(trace_payload, dict):
            return None
        provider = str(trace_payload.get("provider") or "").strip()
        if not provider:
            return None
        execution_id = str(trace_payload.get("execution_id") or "").strip() or None
        anchor_id = str(trace_payload.get("anchor_id") or "").strip() or None
        channel_message_id = str(trace_payload.get("reply_to_message_id") or "").strip() or None
        channel_target_id = (
            str(trace_payload.get("chat_id") or trace_payload.get("channel_id") or trace_payload.get("handle") or "").strip()
            or None
        )
        approval_id = str(trace_payload.get("approval_id") or "").strip() or None
        return await self.gateway_context.resolve_execution_target(
            provider=provider,
            execution_id=execution_id,
            anchor_id=anchor_id,
            channel_message_id=channel_message_id,
            channel_target_id=channel_target_id,
            approval_id=approval_id,
            conversation_id=str(subject or "").strip() or None,
        )

    def _latest_gateway_user_scope_id(
        self,
        *,
        provider: str,
        instance_id: str,
        chat_id: str,
    ) -> str | None:
        gateway_key = self.gateway_context._gateway_key(
            provider=provider,
            instance_id=instance_id,
            chat_id=chat_id,
        )  # noqa: SLF001
        conversation = self.gateway_context.store.get_or_create_conversation(
            provider=provider,
            gateway_key=gateway_key,
            instance_id=instance_id,
            bot_id="unknown-bot",
            chat_id=chat_id,
        )
        messages = self.gateway_context.store.list_context_messages(conversation["id"], limit=500)
        latest_user = next(
            (
                item
                for item in reversed(messages)
                if str(item.get("role") or "") == "user"
                and str(((item.get("metadata") if isinstance(item.get("metadata"), dict) else {}) or {}).get("source") or "")
                != f"{provider}.gateway.resume"
            ),
            None,
        )
        if latest_user is None:
            latest_user = next((item for item in reversed(messages) if str(item.get("role") or "") == "user"), None)
        if not latest_user:
            return None
        value = str(latest_user.get("id") or "").strip()
        return value or None

    async def handle_text_approval_command(
        self,
        *,
        text: str,
        source: str,
        subject: str | None,
        trace_payload: dict[str, Any] | None = None,
    ) -> dict[str, Any] | None:
        parsed = parse_approval_text_command(text)
        kind = str(parsed.get("kind") or "none")
        if kind == "none":
            return None

        pending = self.engine.list_approvals(status="pending", limit=500)
        history = self.engine.list_approvals(limit=500)
        scope_ids = self._approval_scope_ids_from_trace_payload(trace_payload)
        trace_provider = self._trace_string(trace_payload, "provider")
        trace_instance_id = self._trace_string(trace_payload, "instance_id")
        bound_execution = await self._bound_execution_from_trace_payload(
            trace_payload=trace_payload,
            subject=subject,
        )
        def _matches(item: Any) -> bool:
            return self._approval_matches_subject(
                item,
                subject,
                scope_ids=scope_ids,
                provider=trace_provider,
                instance_id=trace_instance_id,
            )

        targeting = build_approval_targeting_state(
            pending=pending,
            history=history,
            bound_execution=bound_execution,
            matcher=_matches,
        )

        if kind == "list":
            return {
                "command": kind,
                "recognized": True,
                "resolved": False,
                "resolved_count": 0,
                "pending_count": len(targeting.candidate_pool),
                "scope": targeting.scope_label,
            }

        decision = "approved" if kind in {"approve", "approve_all"} else "rejected"
        execution_id = targeting.execution_id
        requested_id = parsed.get("approval_id")
        requested_ids = [requested_id] if isinstance(requested_id, str) and requested_id else []
        action_idempotency_key = self._approval_action_idempotency_key(
            source=source,
            action=decision,
            subject=subject,
            trace_payload=trace_payload,
            approval_ids=requested_ids or targeting.bound_approval_ids,
            execution_id=str(execution_id or "").strip() or None,
            scope_ids=scope_ids,
        )
        if action_idempotency_key and self.engine.store.exists_idempotency(action_idempotency_key):
            duplicate_approval_ids = duplicate_approval_ids_for_state(
                requested_ids=requested_ids,
                decision=decision,
                state=targeting,
            )
            return {
                "command": kind,
                "recognized": True,
                "resolved": True,
                "resolved_count": 0,
                "approval_ids": duplicate_approval_ids,
                "status": decision,
                "scope": targeting.scope_label,
                "execution_id": execution_id,
                "duplicate": True,
                "reason": "idempotency_hit",
            }

        def _requested_in_scope(item: Any) -> bool:
            if not targeting.bound_approval_ids and not scope_ids and not subject:
                return True
            if (
                requested_id
                and not targeting.bound_approval_ids
                and not targeting.scoped_pending
            ):
                return True
            return item.approval_id in set(targeting.bound_approval_ids) or _matches(item)

        target_ids, target_error = resolve_target_ids_for_text_command(
            kind=kind,
            requested_id=requested_id if isinstance(requested_id, str) else None,
            pending=pending,
            state=targeting,
            requested_in_scope=_requested_in_scope,
        )

        if target_error:
            return {
                "command": kind,
                "recognized": True,
                "resolved": False,
                "resolved_count": 0,
                "pending_count": len(targeting.candidate_pool),
                "scope": targeting.scope_label,
                "reason": target_error,
            }

        resolution = await self.resolve_gateway_approval_command(
            engine=self.engine,
            target_ids=target_ids,
            decision=decision,
            source=source,
            subject=subject or (target_ids[0] if target_ids else None),
            trace_payload={"text": text, **(trace_payload or {})},
            action_idempotency_key=action_idempotency_key,
            execution_id=str(execution_id or "").strip() or None,
        )

        return {
            "command": kind,
            **resolution,
            "scope": targeting.scope_label,
            "execution_id": execution_id,
        }

    async def resolve_gateway_approval_command(
        self,
        *,
        engine: EventEngine,
        target_ids: list[str],
        decision: str,
        source: str,
        subject: str | None,
        trace_payload: dict[str, Any] | None = None,
        action_idempotency_key: str | None = None,
        execution_id: str | None = None,
    ) -> dict[str, Any]:
        return await gateway_resolve_approval_command(
            engine=engine,
            target_ids=target_ids,
            decision=decision,
            source=source,
            subject=subject,
            trace_payload=trace_payload,
            action_idempotency_key=action_idempotency_key,
            execution_id=execution_id,
        )

    async def ingest_feishu_events(
        self,
        payload: dict[str, Any],
        *,
        query_params: Mapping[str, str] | None = None,
        verify_signature: bool = True,
    ) -> dict[str, Any]:
        plugin = self.channel_plugin("feishu")
        if not plugin:
            raise GatewayManagerError("unsupported_gateway_provider")
        return await plugin.ingest_event(
            self,
            payload,
            query_params=query_params,
            verify_signature=verify_signature,
        )

    async def ingest_feishu_card_actions(
        self,
        payload: dict[str, Any],
        *,
        query_params: Mapping[str, str] | None = None,
    ) -> dict[str, Any]:
        plugin = self.channel_plugin("feishu")
        if not plugin:
            raise GatewayManagerError("unsupported_gateway_provider")
        return await plugin.ingest_card_action(
            self,
            payload,
            query_params=query_params,
        )

    async def ingest_telegram_webhook(
        self,
        payload: dict[str, Any],
        *,
        headers: Mapping[str, str] | None,
        query_params: Mapping[str, str] | None = None,
    ) -> dict[str, Any]:
        plugin = self.channel_plugin("telegram")
        if not plugin:
            raise GatewayManagerError("unsupported_gateway_provider")
        return await plugin.ingest_event(
            self,
            payload,
            headers=headers,
            query_params=query_params,
        )

    async def ingest_discord_events(
        self,
        payload: dict[str, Any],
        *,
        query_params: Mapping[str, str] | None = None,
    ) -> dict[str, Any]:
        plugin = self.channel_plugin("discord")
        if not plugin:
            raise GatewayManagerError("unsupported_gateway_provider")
        return await plugin.ingest_event(
            self,
            payload,
            query_params=query_params,
        )
