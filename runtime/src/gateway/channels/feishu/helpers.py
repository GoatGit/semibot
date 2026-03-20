from __future__ import annotations

from collections.abc import Mapping
from typing import TYPE_CHECKING, Any

from src.gateway.channels.shared import query_value

if TYPE_CHECKING:
    from src.gateway.manager import GatewayManager


def _query_value(query_params: Mapping[str, str] | None, *keys: str) -> str | None:
    return query_value(query_params, *keys)


def resolve_instance_for_ingest(
    manager: GatewayManager,
    payload: dict[str, Any],
    query_params: Mapping[str, str] | None,
) -> dict[str, Any] | None:
    from src.gateway.manager import GatewayManagerError

    instance_id = _query_value(query_params, "instanceId", "instance_id")
    if instance_id:
        item = manager._get_instance(instance_id)  # noqa: SLF001
        if item and str(item.get("provider")) == "feishu":
            return item
        raise GatewayManagerError("gateway_instance_not_found", status_code=404)

    active_items = manager.list_provider_instances("feishu", active_only=True)
    if not active_items:
        return None

    token_in_payload = ""
    header = payload.get("header")
    if isinstance(header, dict):
        token_in_payload = str(header.get("token") or "").strip()
    if not token_in_payload:
        token_in_payload = str(payload.get("token") or "").strip()

    matched: list[dict[str, Any]] = []
    if token_in_payload:
        for item in active_items:
            cfg = item.get("config")
            cfg_map = cfg if isinstance(cfg, dict) else {}
            verify_token = str(cfg_map.get("verifyToken") or "").strip()
            if verify_token and verify_token == token_in_payload:
                matched.append(item)
        if len(matched) == 1:
            return matched[0]
        if len(matched) > 1:
            raise GatewayManagerError("ambiguous_feishu_instance", status_code=409)

    if len(active_items) == 1:
        return active_items[0]
    return None
