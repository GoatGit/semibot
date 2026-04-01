"""Tests for text_processing builtin tool."""

import json

import pytest

from src.skills.text_processing import TextProcessingTool


class _DummyResponse:
    def __init__(self, content: str, finish_reason: str = "stop", model: str = "test-model") -> None:
        self.content = content
        self.finish_reason = finish_reason
        self.model = model


class _DummyProvider:
    def __init__(self, content: str) -> None:
        self.content = content
        self.calls: list[dict[str, object]] = []
        self.config = type("Config", (), {"provider_base": "openai", "base_url": "", "model": "test-model"})()

    async def chat(self, **kwargs):  # type: ignore[no-untyped-def]
        self.calls.append(kwargs)
        return _DummyResponse(self.content)


class _RuntimeContext:
    def __init__(self, llm_provider=None) -> None:  # type: ignore[no-untyped-def]
        self.metadata = {"llm_provider": llm_provider} if llm_provider is not None else {}


@pytest.mark.asyncio
async def test_text_processing_extract_requires_llm_provider() -> None:
    tool = TextProcessingTool()

    result = await tool.execute(
        operation="extract",
        text="OpenAI announced a launch.",
        schema={"type": "object", "properties": {"headline": {"type": "string"}}},
        _runtime_context=_RuntimeContext(),
    )

    assert result.success is False
    assert "llm_provider" in (result.error or "")


@pytest.mark.asyncio
async def test_text_processing_extract_returns_valid_object_payload() -> None:
    provider = _DummyProvider(
        json.dumps(
            {
                "data": {"headline": "OpenAI announced a launch", "published_at": "2026-03-13"},
                "warnings": [],
                "evidence": {"headline": "OpenAI announced a launch"},
            },
            ensure_ascii=False,
        )
    )
    tool = TextProcessingTool()

    result = await tool.execute(
        operation="extract",
        text="OpenAI announced a launch on 2026-03-13.",
        schema={
            "type": "object",
            "properties": {
                "headline": {"type": "string"},
                "published_at": {"type": "string"},
            },
            "required": ["headline"],
        },
        include_evidence=True,
        _runtime_context=_RuntimeContext(provider),
    )

    assert result.success is True
    assert result.result["valid"] is True
    assert result.result["items_count"] == 1
    assert result.result["data"]["headline"] == "OpenAI announced a launch"
    assert result.result["evidence"]["headline"] == "OpenAI announced a launch"
    assert provider.calls[0]["temperature"] == 0


@pytest.mark.asyncio
async def test_text_processing_extract_wraps_array_mode_and_counts_items() -> None:
    provider = _DummyProvider(
        json.dumps(
            {
                "data": [{"headline": "A"}, {"headline": "B"}],
                "warnings": ["normalized_date_missing"],
            },
            ensure_ascii=False,
        )
    )
    tool = TextProcessingTool()

    result = await tool.execute(
        operation="extract",
        text="A\nB",
        schema={"type": "object", "properties": {"headline": {"type": "string"}}},
        extract_mode="array_of_objects",
        max_items=2,
        _runtime_context=_RuntimeContext(provider),
    )

    assert result.success is True
    assert result.result["valid"] is True
    assert result.result["items_count"] == 2
    response_format = provider.calls[0]["response_format"]
    assert response_format["json_schema"]["schema"]["properties"]["data"]["type"] == "array"


@pytest.mark.asyncio
async def test_text_processing_compact_returns_text() -> None:
    provider = _DummyProvider(
        json.dumps({"text": "压缩后的摘要", "warnings": []}, ensure_ascii=False)
    )
    tool = TextProcessingTool()

    result = await tool.execute(
        operation="compact",
        text="这是很长的原文",
        max_chars=300,
        _runtime_context=_RuntimeContext(provider),
    )

    assert result.success is True
    assert result.result["text"] == "压缩后的摘要"
    assert result.result["truncated"] is False


@pytest.mark.asyncio
async def test_text_processing_brief_returns_mode_style_and_metadata() -> None:
    provider = _DummyProvider(
        json.dumps({"text": "要点一\n要点二", "warnings": []}, ensure_ascii=False)
    )
    tool = TextProcessingTool()

    result = await tool.execute(
        operation="brief",
        text="这是很长的原文",
        brief_mode="key_points",
        style="bullet",
        max_chars=200,
        _runtime_context=_RuntimeContext(provider),
    )

    assert result.success is True
    assert result.result["text"] == "要点一\n要点二"
    assert result.result["mode"] == "key_points"
    assert result.result["style"] == "bullet"
    assert result.result["metadata"]["source_chars"] == len("这是很长的原文")
    assert result.result["metadata"]["output_chars"] == len("要点一\n要点二")


@pytest.mark.asyncio
async def test_text_processing_brief_requires_llm_provider() -> None:
    tool = TextProcessingTool()

    result = await tool.execute(
        operation="brief",
        text="OpenAI announced a launch.",
        brief_mode="summary",
        _runtime_context=_RuntimeContext(),
    )

    assert result.success is False
    assert "llm_provider" in (result.error or "")


@pytest.mark.asyncio
async def test_text_processing_brief_omits_response_format_for_claude_proxy_like_provider() -> None:
    provider = _DummyProvider(
        json.dumps({"text": "brief output", "warnings": []}, ensure_ascii=False)
    )
    provider.config = type("Config", (), {"provider_base": "custom", "base_url": "", "model": "claude-3-5-sonnet"})()
    tool = TextProcessingTool()

    result = await tool.execute(
        operation="brief",
        text="Source text",
        brief_mode="summary",
        _runtime_context=_RuntimeContext(provider),
    )

    assert result.success is True
    assert provider.calls[0]["response_format"] is None


def test_text_processing_slice_supports_query_window() -> None:
    tool = TextProcessingTool()
    result = tool._slice(
        text="0123456789abcdef",
        max_chars=6,
        query="6789",
        start_char=None,
        end_char=None,
        window_chars=8,
    )

    assert result.success is True
    assert result.result["slices"][0]["matched_query"] == "6789"
    assert "6789" in result.result["slices"][0]["text"]
    assert result.result["truncated"] is True


@pytest.mark.asyncio
async def test_text_processing_extract_returns_error_on_invalid_json() -> None:
    provider = _DummyProvider('{"data": ')
    tool = TextProcessingTool()

    result = await tool.execute(
        operation="extract",
        text="Bad payload",
        schema={"type": "object", "properties": {"headline": {"type": "string"}}},
        _runtime_context=_RuntimeContext(provider),
    )

    assert result.success is False
    assert "invalid JSON" in (result.error or "")


# ---------------------------------------------------------------------------
# operation=transform tests (migrated from test_json_transform.py)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_transform_selector_and_mapping() -> None:
    tool = TextProcessingTool()
    data = {
        "user": {"name": "Alice", "profile": {"city": "Shanghai"}},
        "items": [{"price": 10}, {"price": 20}],
    }

    selector = await tool.execute(operation="transform", data=data, expression="$.user.name")
    assert selector.success is True
    assert selector.result["output"] == "Alice"

    mapped = await tool.execute(
        operation="transform",
        data=data,
        transform_language="mapping",
        mapping={
            "name": "$.user.name",
            "city": "user.profile.city",
            "prices": "$.items[*].price",
        },
    )
    assert mapped.success is True
    assert mapped.result["output"]["name"] == "Alice"
    assert mapped.result["output"]["city"] == "Shanghai"
    assert mapped.result["output"]["prices"] == [10, 20]


@pytest.mark.asyncio
async def test_transform_template() -> None:
    tool = TextProcessingTool()
    result = await tool.execute(
        operation="transform",
        data={"order": {"id": "o_1", "total": 99.5}},
        transform_language="template",
        template="Order {{$.order.id}} total={{order.total}}",
    )
    assert result.success is True
    assert result.result["output"] == "Order o_1 total=99.5"
