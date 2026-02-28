"""Tests for json_transform builtin tool."""

import pytest

from src.skills.json_transform import JsonTransformTool


@pytest.mark.asyncio
async def test_json_transform_selector_and_mapping() -> None:
    tool = JsonTransformTool()
    data = {
        "user": {"name": "Alice", "profile": {"city": "Shanghai"}},
        "items": [{"price": 10}, {"price": 20}],
    }

    selector = await tool.execute(data=data, expression="$.user.name")
    assert selector.success is True
    assert selector.result["output"] == "Alice"

    mapped = await tool.execute(
        data=data,
        language="mapping",
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
async def test_json_transform_template() -> None:
    tool = JsonTransformTool()
    result = await tool.execute(
        data={"order": {"id": "o_1", "total": 99.5}},
        language="template",
        template="Order {{$.order.id}} total={{order.total}}",
    )
    assert result.success is True
    assert result.result["output"] == "Order o_1 total=99.5"
