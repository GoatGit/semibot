"""Pydantic schemas for gateway HTTP routes."""

from __future__ import annotations

from typing import Any

from pydantic import AliasChoices, BaseModel, ConfigDict, Field


class GatewayConfigPatchRequest(BaseModel):
    """Patch payload for gateway config APIs.

    Supports both camelCase and snake_case for backward compatibility.
    Unknown keys are preserved and passed through to manager.
    """

    model_config = ConfigDict(extra="allow", populate_by_name=True)

    display_name: str | None = Field(
        default=None,
        validation_alias=AliasChoices("displayName", "display_name"),
    )
    is_active: bool | None = Field(
        default=None,
        validation_alias=AliasChoices("isActive", "is_active"),
    )
    mode: str | None = None
    risk_level: str | None = Field(
        default=None,
        validation_alias=AliasChoices("riskLevel", "risk_level"),
    )
    requires_approval: bool | None = Field(
        default=None,
        validation_alias=AliasChoices("requiresApproval", "requires_approval"),
    )
    config: dict[str, Any] | None = None
    addressing_policy: dict[str, Any] | None = Field(
        default=None,
        validation_alias=AliasChoices("addressingPolicy"),
    )
    proactive_policy: dict[str, Any] | None = Field(
        default=None,
        validation_alias=AliasChoices("proactivePolicy"),
    )
    context_policy: dict[str, Any] | None = Field(
        default=None,
        validation_alias=AliasChoices("contextPolicy"),
    )
    clear_fields: list[str] | None = Field(
        default=None,
        validation_alias=AliasChoices("clearFields", "clear_fields"),
    )

    def to_manager_payload(self) -> dict[str, Any]:
        payload: dict[str, Any] = {}
        mapping = {
            "display_name": "displayName",
            "is_active": "isActive",
            "mode": "mode",
            "risk_level": "riskLevel",
            "requires_approval": "requiresApproval",
            "config": "config",
            "addressing_policy": "addressingPolicy",
            "proactive_policy": "proactivePolicy",
            "context_policy": "contextPolicy",
            "clear_fields": "clearFields",
        }
        for field_name in self.model_fields_set:
            key = mapping.get(field_name)
            if not key:
                continue
            payload[key] = getattr(self, field_name)
        if self.model_extra:
            payload.update(self.model_extra)
        return payload


class GatewayProviderTestRequest(BaseModel):
    """Unified request model for provider test endpoints."""

    model_config = ConfigDict(extra="allow", populate_by_name=True)

    title: str | None = None
    content: str | None = None
    channel: str | None = None
    text: str | None = None
    chat_id: str | None = Field(
        default=None,
        validation_alias=AliasChoices("chat_id", "chatId"),
    )
    instance_id: str | None = Field(
        default=None,
        validation_alias=AliasChoices("instance_id", "instanceId"),
    )

    def to_manager_payload(self) -> dict[str, Any]:
        payload: dict[str, Any] = {}
        mapping = {
            "title": "title",
            "content": "content",
            "channel": "channel",
            "text": "text",
            "chat_id": "chat_id",
            "instance_id": "instance_id",
        }
        for field_name in self.model_fields_set:
            key = mapping.get(field_name)
            if not key:
                continue
            payload[key] = getattr(self, field_name)
        if self.model_extra:
            payload.update(self.model_extra)
        return payload


class GatewayInstanceCreateRequest(GatewayConfigPatchRequest):
    provider: str = Field(
        validation_alias=AliasChoices("provider"),
    )
    instance_key: str | None = Field(
        default=None,
        validation_alias=AliasChoices("instance_key", "instanceKey"),
    )

    def to_manager_payload(self) -> dict[str, Any]:
        payload = super().to_manager_payload()
        payload["provider"] = self.provider
        if "instance_key" in self.model_fields_set:
            payload["instance_key"] = self.instance_key
        return payload
