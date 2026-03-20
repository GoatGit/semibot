"""Gateway route registration.

Keep API layer thin: decode HTTP request/response and delegate to GatewayManager.
"""

from __future__ import annotations

from typing import Any

from fastapi import FastAPI, HTTPException, Query, Request

from src.gateway.manager import GatewayManager, GatewayManagerError
from src.server.routes.gateway_schemas import (
    GatewayBatchRequest,
    GatewayConfigPatchRequest,
    GatewayInstanceCreateRequest,
    GatewayProviderTestRequest,
)


def register_gateway_routes(
    app: FastAPI,
    gateway_manager: GatewayManager,
    *,
    internal_tokens: dict[str, str] | None = None,
) -> None:
    token_map = dict(internal_tokens or {})

    async def _read_json(request: Request) -> dict[str, Any]:
        try:
            payload = await request.json()
        except Exception:
            return {}
        return payload if isinstance(payload, dict) else {}

    def _check_internal_token(request: Request, expected_token: str | None) -> None:
        expected = str(expected_token or "").strip()
        provided = str(request.headers.get("x-semibot-internal-token", "")).strip()
        if not expected or provided != expected:
            raise HTTPException(status_code=401, detail="invalid_internal_token")

    async def _ingest_channel_event(
        provider: str,
        request: Request,
        *,
        internal_token: str | None = None,
        verify_signature: bool = True,
    ) -> dict[str, Any]:
        if internal_token is not None:
            _check_internal_token(request, internal_token)
        payload = await _read_json(request)
        try:
            plugin = gateway_manager.channel_plugin(provider)
            if not plugin:
                raise GatewayManagerError("unsupported_gateway_provider")
            return await plugin.ingest_event(
                gateway_manager,
                payload,
                headers=request.headers,
                query_params=request.query_params,
                verify_signature=verify_signature,
            )
        except GatewayManagerError as exc:
            raise HTTPException(status_code=exc.status_code, detail=exc.detail) from exc

    async def _ingest_channel_card_action(
        provider: str,
        request: Request,
    ) -> dict[str, Any]:
        payload = await _read_json(request)
        try:
            plugin = gateway_manager.channel_plugin(provider)
            if not plugin:
                raise GatewayManagerError("unsupported_gateway_provider")
            return await plugin.ingest_card_action(
                gateway_manager,
                payload,
                query_params=request.query_params,
            )
        except GatewayManagerError as exc:
            raise HTTPException(status_code=exc.status_code, detail=exc.detail) from exc

    async def _test_channel_outbound(
        provider: str,
        req: GatewayProviderTestRequest,
        *,
        defaults: dict[str, Any],
    ) -> dict[str, Any]:
        payload = req.to_manager_payload()
        for key, value in defaults.items():
            current = payload.get(key)
            if current in {None, ""}:
                payload[key] = value
        try:
            return await gateway_manager.test_gateway(provider, payload)
        except GatewayManagerError as exc:
            raise HTTPException(status_code=exc.status_code, detail=exc.detail) from exc

    @app.get("/v1/config/gateways")
    async def list_config_gateways() -> dict[str, Any]:
        return {"data": gateway_manager.list_gateway_configs()}

    @app.get("/v1/config/gateway-instances")
    async def list_gateway_instances(provider: str | None = Query(default=None)) -> dict[str, Any]:
        return {"data": gateway_manager.list_gateway_instances(provider=provider)}

    @app.post("/v1/config/gateway-instances", status_code=201)
    async def create_gateway_instance(req: GatewayInstanceCreateRequest) -> dict[str, Any]:
        try:
            return gateway_manager.create_gateway_instance(req.to_manager_payload())
        except GatewayManagerError as exc:
            raise HTTPException(status_code=exc.status_code, detail=exc.detail) from exc

    @app.post("/v1/config/gateway-instances/batch")
    async def batch_gateway_instances(req: GatewayBatchRequest) -> dict[str, Any]:
        try:
            return gateway_manager.batch_gateway_instances(req.to_manager_payload())
        except GatewayManagerError as exc:
            raise HTTPException(status_code=exc.status_code, detail=exc.detail) from exc

    @app.get("/v1/config/gateway-instances/{instance_id}")
    async def get_gateway_instance(instance_id: str) -> dict[str, Any]:
        try:
            return gateway_manager.get_gateway_instance(instance_id)
        except GatewayManagerError as exc:
            raise HTTPException(status_code=exc.status_code, detail=exc.detail) from exc

    @app.put("/v1/config/gateway-instances/{instance_id}")
    async def update_gateway_instance(instance_id: str, req: GatewayConfigPatchRequest) -> dict[str, Any]:
        try:
            return gateway_manager.update_gateway_instance(instance_id, req.to_manager_payload())
        except GatewayManagerError as exc:
            raise HTTPException(status_code=exc.status_code, detail=exc.detail) from exc

    @app.delete("/v1/config/gateway-instances/{instance_id}")
    async def delete_gateway_instance(instance_id: str) -> dict[str, Any]:
        try:
            return gateway_manager.delete_gateway_instance(instance_id)
        except GatewayManagerError as exc:
            raise HTTPException(status_code=exc.status_code, detail=exc.detail) from exc

    @app.post("/v1/config/gateway-instances/{instance_id}/test")
    async def test_gateway_instance(instance_id: str, req: GatewayProviderTestRequest) -> dict[str, Any]:
        try:
            payload = req.to_manager_payload()
            payload["instance_id"] = instance_id
            target = gateway_manager.get_gateway_instance(instance_id)
            return await gateway_manager.test_gateway(str(target.get("provider")), payload)
        except GatewayManagerError as exc:
            raise HTTPException(status_code=exc.status_code, detail=exc.detail) from exc

    @app.get("/v1/config/gateways/{provider}")
    async def get_config_gateway(provider: str) -> dict[str, Any]:
        try:
            return gateway_manager.get_gateway_config(provider)
        except GatewayManagerError as exc:
            raise HTTPException(status_code=exc.status_code, detail=exc.detail) from exc

    @app.put("/v1/config/gateways/{provider}")
    async def upsert_config_gateway(provider: str, req: GatewayConfigPatchRequest) -> dict[str, Any]:
        try:
            return gateway_manager.upsert_gateway_config(provider, req.to_manager_payload())
        except GatewayManagerError as exc:
            raise HTTPException(status_code=exc.status_code, detail=exc.detail) from exc

    @app.post("/v1/config/gateways/{provider}/test")
    async def test_config_gateway(provider: str, req: GatewayProviderTestRequest) -> dict[str, Any]:
        try:
            return await gateway_manager.test_gateway(provider, req.to_manager_payload())
        except GatewayManagerError as exc:
            raise HTTPException(status_code=exc.status_code, detail=exc.detail) from exc

    @app.get("/v1/gateway/conversations")
    async def list_gateway_conversations(
        provider: str | None = Query(default=None),
        limit: int = Query(default=100, ge=1, le=500),
    ) -> dict[str, Any]:
        return await gateway_manager.alist_gateway_conversations(provider=provider, limit=limit)

    @app.get("/v1/gateway/conversations/{conversation_id}")
    async def get_gateway_conversation(conversation_id: str) -> dict[str, Any]:
        try:
            return await gateway_manager.aget_gateway_conversation(conversation_id)
        except GatewayManagerError as exc:
            raise HTTPException(status_code=exc.status_code, detail=exc.detail) from exc

    @app.get("/v1/gateway/conversations/{conversation_id}/runs")
    async def list_gateway_conversation_runs(
        conversation_id: str,
        limit: int = Query(default=100, ge=1, le=500),
    ) -> dict[str, Any]:
        return await gateway_manager.alist_gateway_conversation_runs(conversation_id, limit=limit)

    @app.get("/v1/gateway/conversations/{conversation_id}/context")
    async def get_gateway_conversation_context(
        conversation_id: str,
        limit: int = Query(default=200, ge=1, le=1000),
    ) -> dict[str, Any]:
        return gateway_manager.get_gateway_conversation_context(conversation_id, limit=limit)

    @app.post("/v1/integrations/feishu/events")
    async def ingest_feishu_events(request: Request) -> dict[str, Any]:
        return await _ingest_channel_event("feishu", request)

    @app.post("/v1/integrations/feishu/events/internal")
    async def ingest_feishu_events_internal(request: Request) -> dict[str, Any]:
        return await _ingest_channel_event(
            "feishu",
            request,
            internal_token=token_map.get("feishu"),
            verify_signature=False,
        )

    @app.post("/v1/integrations/feishu/card-actions")
    async def ingest_feishu_card_actions(request: Request) -> dict[str, Any]:
        return await _ingest_channel_card_action("feishu", request)

    @app.post("/v1/integrations/feishu/outbound/test")
    async def send_feishu_test(req: GatewayProviderTestRequest) -> dict[str, Any]:
        return await _test_channel_outbound(
            "feishu",
            req,
            defaults={
                "title": "Semibot 测试消息",
                "content": "这是一条来自 Semibot 的测试通知。",
                "channel": "default",
            },
        )

    @app.post("/v1/integrations/telegram/webhook")
    async def ingest_telegram_webhook(request: Request) -> dict[str, Any]:
        return await _ingest_channel_event("telegram", request)

    @app.post("/v1/integrations/telegram/events/internal")
    async def ingest_telegram_events_internal(request: Request) -> dict[str, Any]:
        return await _ingest_channel_event(
            "telegram",
            request,
            internal_token=token_map.get("telegram"),
            verify_signature=False,
        )

    @app.post("/v1/integrations/telegram/outbound/test")
    async def send_telegram_test(req: GatewayProviderTestRequest) -> dict[str, Any]:
        return await _test_channel_outbound(
            "telegram",
            req,
            defaults={"text": "Semibot Telegram 测试消息"},
        )

    @app.post("/v1/integrations/discord/outbound/test")
    async def send_discord_test(req: GatewayProviderTestRequest) -> dict[str, Any]:
        return await _test_channel_outbound(
            "discord",
            req,
            defaults={"text": "Semibot Discord 测试消息"},
        )

    @app.post("/v1/integrations/discord/events/internal")
    async def ingest_discord_events_internal(request: Request) -> dict[str, Any]:
        return await _ingest_channel_event(
            "discord",
            request,
            internal_token=token_map.get("discord"),
        )

    @app.post("/v1/integrations/whatsapp/outbound/test")
    async def send_whatsapp_test(req: GatewayProviderTestRequest) -> dict[str, Any]:
        return await _test_channel_outbound(
            "whatsapp",
            req,
            defaults={"text": "Semibot WhatsApp 测试消息"},
        )

    @app.post("/v1/integrations/whatsapp/events/internal")
    async def ingest_whatsapp_events_internal(request: Request) -> dict[str, Any]:
        return await _ingest_channel_event(
            "whatsapp",
            request,
            internal_token=token_map.get("whatsapp"),
        )

    @app.post("/v1/integrations/imessage/outbound/test")
    async def send_imessage_test(req: GatewayProviderTestRequest) -> dict[str, Any]:
        return await _test_channel_outbound(
            "imessage",
            req,
            defaults={"text": "Semibot iMessage 测试消息"},
        )

    @app.post("/v1/integrations/imessage/events/internal")
    async def ingest_imessage_events_internal(request: Request) -> dict[str, Any]:
        return await _ingest_channel_event(
            "imessage",
            request,
            internal_token=token_map.get("imessage"),
        )
