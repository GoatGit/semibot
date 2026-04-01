"""Builtin text processing tool."""

from __future__ import annotations

import json
import os
import re
from typing import Any

from src.llm.provider_capabilities import resolve_provider_capabilities
from src.skills.base import BaseTool, ToolResult

try:
    from jsonschema import ValidationError, validate as jsonschema_validate
except Exception:  # pragma: no cover - optional dependency
    ValidationError = Exception  # type: ignore[assignment]
    jsonschema_validate = None


# ---------------------------------------------------------------------------
# JSON transform helpers (merged from json_transform.py)
# ---------------------------------------------------------------------------

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


# ---------------------------------------------------------------------------


_DEFAULT_MAX_SOURCE_TEXT_CHARS = 20000
_DEFAULT_COMPACT_MAX_CHARS = 1200
_DEFAULT_SLICE_WINDOW_CHARS = 1200


def _truncate_text(value: str, limit: int) -> tuple[str, bool]:
    text = str(value or "")
    if len(text) <= limit:
        return text, False
    return text[:limit], True


def _coerce_object(value: Any) -> dict[str, Any] | None:
    return value if isinstance(value, dict) else None


def _get_llm_provider(runtime_context: Any) -> Any:
    metadata = getattr(runtime_context, "metadata", None)
    return metadata.get("llm_provider") if isinstance(metadata, dict) else None


def _get_text_processing_model_config(runtime_context: Any) -> tuple[str | None, float]:
    """Return (model, temperature) for the text_processing role.

    Falls back to (agent_config.model, 0) if no role config is set.
    temperature is always 0 unless explicitly overridden via model_roles.
    """
    agent_config = getattr(runtime_context, "agent_config", None)
    if agent_config is None:
        return None, 0
    role_cfg = getattr(agent_config.model_roles, "text_processing", None)
    model = (role_cfg.model if role_cfg else None) or agent_config.model or None
    temperature = role_cfg.temperature if (role_cfg and role_cfg.temperature is not None) else 0
    return model, temperature


def _get_effective_response_format(
    runtime_context: Any,
    llm_provider: Any,
    response_format: dict[str, Any],
    model: str | None,
) -> dict[str, Any] | None:
    caps = resolve_provider_capabilities(llm_provider=llm_provider, model=model)
    if not caps.supports_response_format_param:
        return None
    if caps.supports_json_schema_response_format:
        return response_format
    if response_format.get("type") == "json_schema":
        return {"type": "json_object"}
    return response_format


def _validate_extracted_data(data: Any, schema: dict[str, Any]) -> tuple[bool, str | None]:
    if jsonschema_validate is None:
        if isinstance(schema, dict) and schema.get("type") == "object" and not isinstance(data, dict):
            return False, "Extracted data is not an object"
        if isinstance(schema, dict) and schema.get("type") == "array" and not isinstance(data, list):
            return False, "Extracted data is not an array"
        return True, None
    try:
        jsonschema_validate(instance=data, schema=schema)
        return True, None
    except ValidationError as exc:  # pragma: no cover - depends on optional package
        return False, str(exc)


def _count_items(data: Any, extract_mode: str) -> int:
    if extract_mode == "array_of_objects":
        return len(data) if isinstance(data, list) else 0
    return 1 if isinstance(data, dict) else 0


def _extract_wrapper_schema(*, target_schema: dict[str, Any], include_evidence: bool) -> dict[str, Any]:
    properties: dict[str, Any] = {
        "data": target_schema,
        "warnings": {
            "type": "array",
            "items": {"type": "string"},
            "default": [],
        },
    }
    if include_evidence:
        properties["evidence"] = {
            "type": "object",
            "additionalProperties": {"type": "string"},
            "default": {},
        }
    return {
        "type": "json_schema",
        "json_schema": {
            "name": "text_processing_extract_response",
            "schema": {
                "type": "object",
                "properties": properties,
                "required": ["data"],
                "additionalProperties": False,
            },
        },
    }


def _compact_wrapper_schema() -> dict[str, Any]:
    return {
        "type": "json_schema",
        "json_schema": {
            "name": "text_processing_compact_response",
            "schema": {
                "type": "object",
                "properties": {
                    "text": {"type": "string"},
                    "warnings": {
                        "type": "array",
                        "items": {"type": "string"},
                        "default": [],
                    },
                },
                "required": ["text"],
                "additionalProperties": False,
            },
        },
    }


def _brief_wrapper_schema() -> dict[str, Any]:
    return {
        "type": "json_schema",
        "json_schema": {
            "name": "text_processing_brief_response",
            "schema": {
                "type": "object",
                "properties": {
                    "text": {"type": "string"},
                    "warnings": {
                        "type": "array",
                        "items": {"type": "string"},
                        "default": [],
                    },
                },
                "required": ["text"],
                "additionalProperties": False,
            },
        },
    }


class TextProcessingTool(BaseTool):
    @property
    def search_hint(self) -> str:
        return "summarize long text, extract key points, compress text, transform structured data"

    @property
    def name(self) -> str:
        return "text_processing"

    @property
    def description(self) -> str:
        return (
            "Process text with one builtin tool. "
            "operation=compact returns a short factual summary as text. "
            "operation=brief returns summary, brief, key_points, or compress output with explicit mode/style metadata. "
            "operation=extract returns structured data that matches a provided JSON schema. "
            "operation=slice returns a deterministic slice wrapped in a slices array with offsets. "
            "operation=transform applies JSON selectors, field mappings, or templates to structured data. "
            "In auto mode for transform, template wins first, then mapping, then selector."
        )

    @property
    def parameters(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "operation": {
                    "type": "string",
                    "enum": ["brief", "compact", "extract", "slice", "transform"],
                    "description": "Text processing operation to run: brief, compact, extract, slice, or transform.",
                },
                "text": {
                    "type": "string",
                    "description": "Source text to process.",
                },
                "instructions": {
                    "type": "string",
                    "description": "Optional processing guidance. Used only for operation=brief, operation=compact, or operation=extract.",
                },
                "brief_mode": {
                    "type": "string",
                    "enum": ["summary", "brief", "key_points", "compress"],
                    "default": "brief",
                    "description": "Briefing mode for operation=brief.",
                },
                "style": {
                    "type": "string",
                    "enum": ["neutral", "executive", "bullet"],
                    "default": "neutral",
                    "description": "Output style for operation=brief.",
                },
                "schema": {
                    "type": "object",
                    "description": "Target JSON schema for operation=extract. Required when operation=extract.",
                },
                "extract_mode": {
                    "type": "string",
                    "enum": ["single_object", "array_of_objects"],
                    "default": "single_object",
                    "description": "Extraction shape for operation=extract only.",
                },
                "max_items": {
                    "type": "integer",
                    "description": "Maximum items to extract. Used only when operation=extract and extract_mode=array_of_objects.",
                },
                "include_evidence": {
                    "type": "boolean",
                    "default": False,
                    "description": "Whether to include short evidence snippets. Used only for operation=extract.",
                },
                "max_chars": {
                    "type": "integer",
                    "description": "Character budget for operation=brief or operation=compact, or fallback slice window size for operation=slice.",
                },
                "query": {
                    "type": "string",
                    "description": "Optional substring to locate for operation=slice. Used when start_char/end_char are not provided.",
                },
                "start_char": {
                    "type": "integer",
                    "description": "Start character offset for operation=slice. If provided, slice uses start_char/end_char directly.",
                },
                "end_char": {
                    "type": "integer",
                    "description": "End character offset for operation=slice. If omitted with start_char, max_chars is used as the window length.",
                },
                "window_chars": {
                    "type": "integer",
                    "description": "Window size around the first query match for operation=slice. Used only when slicing by query.",
                },
                "data": {
                    "description": "Input JSON object, array, or JSON string. Used only for operation=transform.",
                },
                "expression": {
                    "type": "string",
                    "description": "Selector expression (JSONPath/JMESPath-like subset). Used for operation=transform in selector mode.",
                },
                "transform_language": {
                    "type": "string",
                    "enum": ["auto", "jsonpath", "jmespath", "mapping", "template"],
                    "default": "auto",
                    "description": "Transform mode for operation=transform.",
                },
                "mapping": {
                    "type": "object",
                    "description": "Field mapping: outputKey -> selector expression. Used for operation=transform in mapping mode.",
                },
                "template": {
                    "type": "string",
                    "description": "Render template with {{$.expr}} placeholders. Used for operation=transform in template mode.",
                },
                "default_value": {"description": "Fallback value when selector misses. Used for operation=transform."},
                "keep_nulls": {"type": "boolean", "default": False, "description": "Keep keys whose selector resolves to null/missing. Used for operation=transform mapping mode."},
            },
            "required": ["operation"],
        }

    async def execute(
        self,
        operation: str,
        text: str | None = None,
        instructions: str | None = None,
        brief_mode: str = "brief",
        style: str = "neutral",
        schema: dict[str, Any] | None = None,
        extract_mode: str = "single_object",
        max_items: int | None = None,
        include_evidence: bool = False,
        max_chars: int | None = None,
        query: str | None = None,
        start_char: int | None = None,
        end_char: int | None = None,
        window_chars: int | None = None,
        data: Any = None,
        expression: str | None = None,
        transform_language: str = "auto",
        mapping: dict[str, Any] | None = None,
        template: str | None = None,
        default_value: Any = None,
        keep_nulls: bool = False,
        **kwargs: Any,
    ) -> ToolResult:
        normalized_operation = str(operation or "").strip().lower()
        if normalized_operation == "transform":
            return await self._transform(
                data=data,
                expression=expression,
                transform_language=transform_language,
                mapping=mapping,
                template=template,
                default_value=default_value,
                keep_nulls=keep_nulls,
            )
        if not isinstance(text, str) or not text:
            return ToolResult.error_result("text is required for brief, compact, extract, and slice operations")
        if normalized_operation == "brief":
            return await self._brief(
                text=text,
                instructions=instructions,
                brief_mode=brief_mode,
                style=style,
                max_chars=max_chars,
                runtime_context=kwargs.get("_runtime_context"),
            )
        if normalized_operation == "compact":
            return await self._compact(
                text=text,
                instructions=instructions,
                max_chars=max_chars,
                runtime_context=kwargs.get("_runtime_context"),
            )
        if normalized_operation == "extract":
            return await self._extract(
                text=text,
                schema=schema,
                instructions=instructions,
                extract_mode=extract_mode,
                max_items=max_items,
                include_evidence=include_evidence,
                runtime_context=kwargs.get("_runtime_context"),
            )
        if normalized_operation == "slice":
            return self._slice(
                text=text,
                max_chars=max_chars,
                query=query,
                start_char=start_char,
                end_char=end_char,
                window_chars=window_chars,
            )
        return ToolResult.error_result("operation must be one of brief, compact, extract, slice, or transform")

    async def _brief(
        self,
        *,
        text: str,
        instructions: str | None,
        brief_mode: str,
        style: str,
        max_chars: int | None,
        runtime_context: Any,
    ) -> ToolResult:
        llm_provider = _get_llm_provider(runtime_context)
        if llm_provider is None:
            return ToolResult.error_result("text_processing brief requires a configured llm_provider")
        tp_model, tp_temperature = _get_text_processing_model_config(runtime_context)

        normalized_mode = str(brief_mode or "brief").strip().lower() or "brief"
        if normalized_mode not in {"summary", "brief", "key_points", "compress"}:
            return ToolResult.error_result("brief_mode must be one of summary, brief, key_points, or compress")
        normalized_style = str(style or "neutral").strip().lower() or "neutral"
        if normalized_style not in {"neutral", "executive", "bullet"}:
            return ToolResult.error_result("style must be one of neutral, executive, or bullet")

        source_limit = int(os.getenv("SEMIBOT_TEXT_PROCESSING_MAX_TEXT_CHARS") or str(_DEFAULT_MAX_SOURCE_TEXT_CHARS))
        bounded_text, truncated = _truncate_text(text, source_limit)
        target_chars = max(120, int(max_chars or _DEFAULT_COMPACT_MAX_CHARS))

        mode_instruction = {
            "summary": "Produce a concise summary that preserves the main facts.",
            "brief": "Produce a tight briefing for a downstream agent or API consumer.",
            "key_points": "Produce the key points only, in dense bullet-style wording.",
            "compress": "Compress the text aggressively while preserving essential facts.",
        }[normalized_mode]
        style_instruction = {
            "neutral": "Use a neutral factual tone.",
            "executive": "Use an executive concise tone focused on decisions and risks.",
            "bullet": "Prefer bullet-style lines, but still return a single text field.",
        }[normalized_style]

        response = await llm_provider.chat(
            messages=[
                {
                    "role": "system",
                    "content": (
                        "You are a briefing engine.\n"
                        f"{mode_instruction}\n"
                        f"{style_instruction}\n"
                        f"Keep the output within about {target_chars} characters.\n"
                        "Return only JSON matching the required schema.\n"
                        "Do not wrap the response in markdown fences."
                    ),
                },
                {
                    "role": "user",
                    "content": json.dumps(
                        {
                            "mode": normalized_mode,
                            "style": normalized_style,
                            "instructions": instructions or "",
                            "max_chars": target_chars,
                            "text": bounded_text,
                        },
                        ensure_ascii=False,
                    ),
                },
            ],
            temperature=tp_temperature,
            model=tp_model,
            response_format=_get_effective_response_format(
                runtime_context=runtime_context,
                llm_provider=llm_provider,
                response_format=_brief_wrapper_schema(),
                model=tp_model,
            ),
        )
        try:
            payload = json.loads(str(response.content or "").strip())
        except Exception as exc:
            return ToolResult.error_result(f"text_processing brief returned invalid JSON: {exc}")
        brief_text = str(payload.get("text") or "").strip()
        warnings = payload.get("warnings")
        if not brief_text:
            return ToolResult.error_result("text_processing brief returned empty text")
        if not isinstance(warnings, list):
            warnings = []
        return ToolResult.success_result(
            {
                "text": brief_text,
                "mode": normalized_mode,
                "style": normalized_style,
                "truncated": truncated,
                "warnings": [str(item) for item in warnings if str(item).strip()],
                "metadata": {
                    "source_chars": len(text),
                    "output_chars": len(brief_text),
                },
            },
            source="llm_text_processing_brief",
            model=getattr(response, "model", None),
            finish_reason=getattr(response, "finish_reason", "stop"),
        )

    async def _compact(
        self,
        *,
        text: str,
        instructions: str | None,
        max_chars: int | None,
        runtime_context: Any,
    ) -> ToolResult:
        llm_provider = _get_llm_provider(runtime_context)
        if llm_provider is None:
            return ToolResult.error_result("text_processing compact requires a configured llm_provider")
        tp_model, tp_temperature = _get_text_processing_model_config(runtime_context)

        source_limit = int(os.getenv("SEMIBOT_TEXT_PROCESSING_MAX_TEXT_CHARS") or str(_DEFAULT_MAX_SOURCE_TEXT_CHARS))
        bounded_text, truncated = _truncate_text(text, source_limit)
        target_chars = max(200, int(max_chars or _DEFAULT_COMPACT_MAX_CHARS))
        messages = [
            {
                "role": "system",
                "content": (
                    "You are a text compaction engine.\n"
                    "Compress the source text into a factual, dense summary.\n"
                    f"Keep the output within about {target_chars} characters.\n"
                    "Do not add markdown, commentary, or JSON beyond the required schema."
                ),
            },
            {
                "role": "user",
                "content": json.dumps(
                    {
                        "instructions": instructions or "",
                        "max_chars": target_chars,
                        "text": bounded_text,
                    },
                    ensure_ascii=False,
                ),
            },
        ]
        response = await llm_provider.chat(
            messages=messages,
            temperature=tp_temperature,
            model=tp_model,
            response_format=_compact_wrapper_schema(),
        )
        try:
            payload = json.loads(str(response.content or "").strip())
        except Exception as exc:
            return ToolResult.error_result(f"text_processing compact returned invalid JSON: {exc}")
        compact_text = str(payload.get("text") or "").strip()
        warnings = payload.get("warnings")
        if not compact_text:
            return ToolResult.error_result("text_processing compact returned empty text")
        if not isinstance(warnings, list):
            warnings = []
        return ToolResult.success_result(
            {
                "text": compact_text,
                "truncated": truncated,
                "warnings": [str(item) for item in warnings if str(item).strip()],
            },
            source="llm_text_processing_compact",
            model=getattr(response, "model", None),
            finish_reason=getattr(response, "finish_reason", "stop"),
        )

    async def _extract(
        self,
        *,
        text: str,
        schema: dict[str, Any] | None,
        instructions: str | None,
        extract_mode: str,
        max_items: int | None,
        include_evidence: bool,
        runtime_context: Any,
    ) -> ToolResult:
        llm_provider = _get_llm_provider(runtime_context)
        if llm_provider is None:
            return ToolResult.error_result("text_processing extract requires a configured llm_provider")
        tp_model, tp_temperature = _get_text_processing_model_config(runtime_context)

        target_schema = _coerce_object(schema)
        if target_schema is None:
            return ToolResult.error_result("schema must be a JSON object for operation=extract")

        normalized_mode = str(extract_mode or "single_object").strip().lower() or "single_object"
        if normalized_mode not in {"single_object", "array_of_objects"}:
            return ToolResult.error_result("extract_mode must be single_object or array_of_objects")

        effective_schema = target_schema
        if normalized_mode == "array_of_objects" and target_schema.get("type") != "array":
            effective_schema = {"type": "array", "items": target_schema}

        source_limit = int(os.getenv("SEMIBOT_TEXT_PROCESSING_MAX_TEXT_CHARS") or str(_DEFAULT_MAX_SOURCE_TEXT_CHARS))
        bounded_text, truncated = _truncate_text(text, source_limit)
        instruction_lines = [
            "You are a structured extraction engine.",
            "Return only structured data that matches the provided schema.",
            "Do not summarize, explain, or add markdown.",
        ]
        if normalized_mode == "array_of_objects" and isinstance(max_items, int) and max_items > 0:
            instruction_lines.append(f"Return at most {max_items} extracted items.")
        if include_evidence:
            instruction_lines.append("Include only short evidence snippets, not long passages.")
        if instructions:
            instruction_lines.append(f"Additional extraction instructions: {instructions}")

        response = await llm_provider.chat(
            messages=[
                {"role": "system", "content": "\n".join(instruction_lines)},
                {
                    "role": "user",
                    "content": json.dumps(
                        {
                            "extract_mode": normalized_mode,
                            "schema": effective_schema,
                            "text": bounded_text,
                        },
                        ensure_ascii=False,
                    ),
                },
            ],
            temperature=tp_temperature,
            model=tp_model,
            response_format=_extract_wrapper_schema(
                target_schema=effective_schema,
                include_evidence=include_evidence,
            ),
        )
        try:
            payload = json.loads(str(response.content or "").strip())
        except Exception as exc:
            return ToolResult.error_result(f"text_processing extract returned invalid JSON: {exc}")
        if not isinstance(payload, dict) or "data" not in payload:
            return ToolResult.error_result("text_processing extract returned an invalid payload")

        data = payload.get("data")
        warnings = payload.get("warnings")
        evidence = payload.get("evidence") if include_evidence else None
        if not isinstance(warnings, list):
            warnings = []
        valid, validation_error = _validate_extracted_data(data, effective_schema)
        if validation_error:
            warnings.append(f"schema_validation: {validation_error}")

        result: dict[str, Any] = {
            "data": data,
            "valid": valid,
            "items_count": _count_items(data, normalized_mode),
            "truncated": truncated,
            "warnings": [str(item) for item in warnings if str(item).strip()],
        }
        if include_evidence:
            result["evidence"] = evidence if isinstance(evidence, dict) else {}

        return ToolResult.success_result(
            result,
            source="llm_text_processing_extract",
            model=getattr(response, "model", None),
            finish_reason=getattr(response, "finish_reason", "stop"),
        )

    def _slice(
        self,
        *,
        text: str,
        max_chars: int | None,
        query: str | None,
        start_char: int | None,
        end_char: int | None,
        window_chars: int | None,
    ) -> ToolResult:
        source_text = str(text or "")
        default_limit = max(1, int(max_chars or _DEFAULT_SLICE_WINDOW_CHARS))
        if isinstance(start_char, int) or isinstance(end_char, int):
            start = max(0, int(start_char or 0))
            end = max(start, int(end_char if end_char is not None else start + default_limit))
        elif isinstance(query, str) and query:
            lower_text = source_text.lower()
            lower_query = query.lower()
            idx = lower_text.find(lower_query)
            if idx < 0:
                return ToolResult.error_result("query was not found in source text")
            window = max(1, int(window_chars or default_limit))
            start = max(0, idx - (window // 2))
            end = min(len(source_text), start + window)
        else:
            start = 0
            end = min(len(source_text), default_limit)

        sliced_text = source_text[start:end]
        slices = [
            {
                "text": sliced_text,
                "start_char": start,
                "end_char": end,
                "matched_query": str(query or "") or None,
            }
        ]
        return ToolResult.success_result(
            {
                "slices": slices,
                "truncated": end < len(source_text) or start > 0,
            },
            source="deterministic_text_slice",
        )

    async def _transform(
        self,
        *,
        data: Any,
        expression: str | None,
        transform_language: str,
        mapping: dict[str, Any] | None,
        template: str | None,
        default_value: Any,
        keep_nulls: bool,
    ) -> ToolResult:
        try:
            payload = _json_load_if_needed(data)
        except Exception as exc:
            return ToolResult.error_result(f"Invalid JSON data: {exc}")

        mode = str(transform_language or "auto").strip().lower()
        if mode not in {"auto", "jsonpath", "jmespath", "mapping", "template"}:
            return ToolResult.error_result(f"Unsupported transform_language: {mode}")

        if mode == "template" or (mode == "auto" and template):
            if not template:
                return ToolResult.error_result("template is required for transform_language=template")

            def _replace(match: re.Match[str]) -> str:
                expr = match.group(1).strip()
                value = _extract_first(payload, expr, default_value=default_value)
                if value is None:
                    return ""
                if isinstance(value, (dict, list)):
                    return json.dumps(value, ensure_ascii=False)
                return str(value)

            rendered = _TEMPLATE_RE.sub(_replace, template)
            return ToolResult.success_result({"mode": "template", "output": rendered})

        if mode == "mapping" or (mode == "auto" and isinstance(mapping, dict)):
            if not isinstance(mapping, dict) or not mapping:
                return ToolResult.error_result("mapping is required for transform_language=mapping")
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
            return ToolResult.success_result({"mode": "mapping", "output": transformed})

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
