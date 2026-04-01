"""Schema-bound structured output adapter."""

from __future__ import annotations

from typing import Any

from src.skills.base import BaseTool, ToolResult

try:
    from jsonschema import SchemaError, ValidationError, validate as jsonschema_validate
except Exception:  # pragma: no cover - optional dependency
    SchemaError = Exception  # type: ignore[assignment]
    ValidationError = Exception  # type: ignore[assignment]
    jsonschema_validate = None


def _validate_schema_value(schema: dict[str, Any], value: Any) -> tuple[bool, str | None]:
    if jsonschema_validate is None:
        schema_type = str(schema.get("type") or "").strip().lower()
        if schema_type == "object" and not isinstance(value, dict):
            return False, "value is not an object"
        if schema_type == "array" and not isinstance(value, list):
            return False, "value is not an array"
        if schema_type == "string" and not isinstance(value, str):
            return False, "value is not a string"
        return True, None
    try:
        jsonschema_validate(instance=value, schema=schema)
        return True, None
    except SchemaError as exc:  # pragma: no cover - depends on optional package
        return False, f"invalid schema: {exc}"
    except ValidationError as exc:  # pragma: no cover - depends on optional package
        return False, str(exc)
class SyntheticOutputTool(BaseTool):
    @property
    def search_hint(self) -> str:
        return "return final response as structured json"

    @property
    def name(self) -> str:
        return "synthetic_output"

    @property
    def description(self) -> str:
        return (
            "Return final schema-bound structured output for API or workflow handoff. "
            "Validate the provided structured payload against the requested schema and return it unchanged."
        )

    @property
    def parameters(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "schema": {
                    "type": "object",
                    "description": "Required JSON schema for the final output value.",
                },
                "instruction": {
                    "type": "string",
                    "description": "Optional caller instruction. Accepted for compatibility, but not used for validation.",
                },
                "text": {
                    "type": "string",
                    "description": "Optional source text. Accepted for compatibility, but not used for validation.",
                },
                "data": {
                    "description": "Optional structured payload alias. Used when value is omitted.",
                },
                "value": {
                    "description": "Structured payload to validate against the schema.",
                },
            },
            "required": ["schema"],
        }

    async def execute(
        self,
        schema: dict[str, Any],
        instruction: str | None = None,
        text: str | None = None,
        data: Any = None,
        value: Any = None,
        **kwargs: Any,
    ) -> ToolResult:
        if not isinstance(schema, dict) or not schema:
            return ToolResult.error_result("schema must be a non-empty JSON object")
        effective_value = value if value is not None else data
        if effective_value is None:
            return ToolResult.error_result("synthetic_output requires value or data")

        valid, validation_error = _validate_schema_value(schema, effective_value)
        if not valid:
            return ToolResult.error_result(f"synthetic_output schema validation failed: {validation_error}")
        return ToolResult.success_result(
            {
                "value": effective_value,
                "valid": True,
                "warnings": [],
            },
            source="synthetic_output_validation",
        )
