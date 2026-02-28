"""Builtin JSON transform tool (JSONPath/JMESPath subset + mapping/template)."""

from __future__ import annotations

import json
import re
from typing import Any

from src.skills.base import BaseTool, ToolResult

_TEMPLATE_RE = re.compile(r"\{\{\s*([^{}]+?)\s*\}\}")


def _normalize_expr(expr: str) -> str:
    normalized = expr.strip()
    if normalized.startswith("$"):
        normalized = normalized[1:]
    if normalized.startswith("."):
        normalized = normalized[1:]
    normalized = re.sub(r"""\[['"]([^'"]+)['"]\]""", r".\1", normalized)
    normalized = re.sub(r"""\[([A-Za-z_][A-Za-z0-9_]*)\]""", r".\1", normalized)
    return normalized


def _tokenize(expr: str) -> list[str | int]:
    tokens: list[str | int] = []
    normalized = _normalize_expr(expr)
    if not normalized:
        return tokens

    index = 0
    current = ""
    while index < len(normalized):
        char = normalized[index]
        if char == ".":
            if current:
                tokens.append(current)
                current = ""
            index += 1
            continue
        if char == "[":
            if current:
                tokens.append(current)
                current = ""
            close = normalized.find("]", index + 1)
            if close < 0:
                break
            inner = normalized[index + 1 : close].strip().strip("'\"")
            if inner == "*":
                tokens.append("*")
            elif inner.isdigit():
                tokens.append(int(inner))
            elif inner:
                tokens.append(inner)
            index = close + 1
            continue
        current += char
        index += 1

    if current:
        tokens.append(current)
    return tokens


def _extract_values(data: Any, expr: str) -> list[Any]:
    tokens = _tokenize(expr)
    if not tokens:
        return [data]

    nodes = [data]
    for token in tokens:
        next_nodes: list[Any] = []
        for node in nodes:
            if token == "*":
                if isinstance(node, list):
                    next_nodes.extend(node)
                elif isinstance(node, dict):
                    next_nodes.extend(node.values())
                continue
            if isinstance(token, int):
                if isinstance(node, list) and 0 <= token < len(node):
                    next_nodes.append(node[token])
                continue
            if isinstance(node, dict) and token in node:
                next_nodes.append(node[token])
        nodes = next_nodes
        if not nodes:
            break
    return nodes


def _extract_first(data: Any, expr: str, default_value: Any = None) -> Any:
    values = _extract_values(data, expr)
    if not values:
        return default_value
    return values[0] if len(values) == 1 else values


def _json_load_if_needed(value: Any) -> Any:
    if isinstance(value, str):
        stripped = value.strip()
        if not stripped:
            return {}
        return json.loads(stripped)
    return value


class JsonTransformTool(BaseTool):
    """Transform JSON payloads using selectors and mapping rules."""

    @property
    def name(self) -> str:
        return "json_transform"

    @property
    def description(self) -> str:
        return (
            "Transform JSON data via JSONPath/JMESPath-compatible selectors, "
            "field mapping templates, and simple render templates."
        )

    @property
    def parameters(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "data": {
                    "description": "Input JSON object/array or JSON string.",
                },
                "expression": {
                    "type": "string",
                    "description": "Selector expression (JSONPath/JMESPath subset).",
                },
                "language": {
                    "type": "string",
                    "enum": ["auto", "jsonpath", "jmespath", "mapping", "template"],
                    "default": "auto",
                },
                "mapping": {
                    "type": "object",
                    "description": "Field mapping: outputKey -> selector expression.",
                },
                "template": {
                    "type": "string",
                    "description": "Render template with placeholders, e.g. {{$.user.name}}.",
                },
                "default_value": {"description": "Fallback value when selector misses."},
                "keep_nulls": {"type": "boolean", "default": False},
            },
            "required": ["data"],
        }

    async def execute(
        self,
        data: Any,
        expression: str | None = None,
        language: str = "auto",
        mapping: dict[str, Any] | None = None,
        template: str | None = None,
        default_value: Any = None,
        keep_nulls: bool = False,
        **_: Any,
    ) -> ToolResult:
        try:
            payload = _json_load_if_needed(data)
        except Exception as exc:
            return ToolResult.error_result(f"Invalid JSON data: {exc}")

        mode = str(language or "auto").strip().lower()
        if mode not in {"auto", "jsonpath", "jmespath", "mapping", "template"}:
            return ToolResult.error_result(f"Unsupported language: {mode}")

        if mode == "template" or (mode == "auto" and template):
            if not template:
                return ToolResult.error_result("template is required for language=template")

            def _replace(match: re.Match[str]) -> str:
                expr = match.group(1).strip()
                value = _extract_first(payload, expr, default_value=default_value)
                if value is None:
                    return ""
                if isinstance(value, (dict, list)):
                    return json.dumps(value, ensure_ascii=False)
                return str(value)

            rendered = _TEMPLATE_RE.sub(_replace, template)
            return ToolResult.success_result(
                {
                    "mode": "template",
                    "output": rendered,
                }
            )

        if mode == "mapping" or (mode == "auto" and isinstance(mapping, dict)):
            if not isinstance(mapping, dict) or not mapping:
                return ToolResult.error_result("mapping is required for language=mapping")
            transformed: dict[str, Any] = {}
            for key, expr in mapping.items():
                key_text = str(key).strip()
                if not key_text:
                    continue
                expr_text = str(expr or "").strip()
                if not expr_text:
                    if keep_nulls:
                        transformed[key_text] = default_value
                    continue
                value = _extract_first(payload, expr_text, default_value=default_value)
                if value is None and not keep_nulls:
                    continue
                transformed[key_text] = value
            return ToolResult.success_result(
                {
                    "mode": "mapping",
                    "output": transformed,
                }
            )

        selector = str(expression or "").strip()
        if not selector:
            return ToolResult.error_result("expression is required")

        values = _extract_values(payload, selector)
        if not values:
            values = [default_value]
        output: Any = values[0] if len(values) == 1 else values

        return ToolResult.success_result(
            {
                "mode": "selector",
                "language": "jsonpath" if selector.startswith("$") else "jmespath",
                "expression": selector,
                "output": output,
            }
        )
