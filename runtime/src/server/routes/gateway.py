"""Gateway route registration.

Keep API layer thin: decode HTTP request/response and delegate to GatewayManager.
"""

from __future__ import annotations

from typing import Any

from fastapi import FastAPI, HTTPException, Query, Request

from src.gateway.manager import GatewayManager, GatewayManagerError
from src.server.routes.gateway_schemas import (
    GatewayConfigPatchRequest,
    GatewayInstanceCreateRequest,
    GatewayProviderTestRequest,
)


def register_gateway_routes(app: FastAPI, gateway_manager: GatewayManager) -> None:
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
        return gateway_manager.list_gateway_conversations(provider=provider, limit=limit)

    @app.get("/v1/gateway/conversations/{conversation_id}/runs")
    async def list_gateway_conversation_runs(
        conversation_id: str,
        limit: int = Query(default=100, ge=1, le=500),
    ) -> dict[str, Any]:
        return gateway_manager.list_gateway_conversation_runs(conversation_id, limit=limit)

    @app.get("/v1/gateway/conversations/{conversation_id}/context")
    async def get_gateway_conversation_context(
        conversation_id: str,
        limit: int = Query(default=200, ge=1, le=1000),
    ) -> dict[str, Any]:
        return gateway_manager.get_gateway_conversation_context(conversation_id, limit=limit)

    @app.post("/v1/integrations/feishu/events")
    async def ingest_feishu_events(request: Request) -> dict[str, Any]:
        try:
            payload = await request.json()
        except Exception:
            payload = {}
        try:
            return await gateway_manager.ingest_feishu_events(
                payload if isinstance(payload, dict) else {},
                query_params=request.query_params,
            )
        except GatewayManagerError as exc:
            raise HTTPException(status_code=exc.status_code, detail=exc.detail) from exc

    @app.post("/v1/integrations/feishu/card-actions")
    async def ingest_feishu_card_actions(request: Request) -> dict[str, Any]:
        try:
            payload = await request.json()
        except Exception:
            payload = {}
        try:
            return await gateway_manager.ingest_feishu_card_actions(
                payload if isinstance(payload, dict) else {},
                query_params=request.query_params,
            )
        except GatewayManagerError as exc:
            raise HTTPException(status_code=exc.status_code, detail=exc.detail) from exc

    @app.post("/v1/integrations/feishu/outbound/test")
    async def send_feishu_test(req: GatewayProviderTestRequest) -> dict[str, Any]:
        try:
            return await gateway_manager.send_feishu_test(
                title=req.title or "Semibot 测试消息",
                content=req.content or "这是一条来自 Semibot 的测试通知。",
                channel=req.channel or "default",
            )
        except GatewayManagerError as exc:
            raise HTTPException(status_code=exc.status_code, detail=exc.detail) from exc

    @app.post("/v1/integrations/telegram/webhook")
    async def ingest_telegram_webhook(request: Request) -> dict[str, Any]:
        try:
            payload = await request.json()
        except Exception:
            payload = {}
        try:
            return await gateway_manager.ingest_telegram_webhook(
                payload if isinstance(payload, dict) else {},
                headers=request.headers,
                query_params=request.query_params,
            )
        except GatewayManagerError as exc:
            raise HTTPException(status_code=exc.status_code, detail=exc.detail) from exc

    @app.post("/v1/integrations/telegram/outbound/test")
    async def send_telegram_test(req: GatewayProviderTestRequest) -> dict[str, Any]:
        try:
            return await gateway_manager.send_telegram_test(
                text=req.text or "Semibot Telegram 测试消息",
                chat_id=req.chat_id,
            )
        except GatewayManagerError as exc:
            raise HTTPException(status_code=exc.status_code, detail=exc.detail) from exc
