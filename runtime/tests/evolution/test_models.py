"""SkillDraft data class tests."""

import pytest
from src.evolution.models import SkillDraft


class TestSkillDraft:
    """SkillDraft 数据类测试"""

    def test_create_valid_draft(self):
        draft = SkillDraft(
            name="查询订单状态",
            description="根据订单号查询订单的当前状态",
            trigger_keywords=["订单", "查询", "状态"],
            steps=[
                {"order": 1, "action": "查询订单", "tool": "order_query", "params_template": {"order_id": "{order_id}"}},
                {"order": 2, "action": "格式化结果", "tool": "formatter", "params_template": {}},
            ],
            tools_used=["order_query", "formatter"],
            parameters={"order_id": {"type": "string", "description": "订单号", "required": True}},
            preconditions={"required_tools": ["order_query"]},
            expected_outcome="返回订单状态信息",
        )
        assert draft.name == "查询订单状态"
        assert draft.is_valid() is True

    def test_invalid_draft_empty_name(self):
        draft = SkillDraft(
            name="",
            description="描述",
            steps=[{"order": 1, "action": "test", "tool": "t"}],
            tools_used=["t"],
        )
        assert draft.is_valid() is False

    def test_invalid_draft_empty_description(self):
        draft = SkillDraft(
            name="技能",
            description="",
            steps=[{"order": 1, "action": "test", "tool": "t"}],
            tools_used=["t"],
        )
        assert draft.is_valid() is False

    def test_invalid_draft_empty_steps(self):
        draft = SkillDraft(
            name="测试技能",
            description="描述",
            steps=[],
            tools_used=["t"],
        )
        assert draft.is_valid() is False

    def test_invalid_draft_empty_tools(self):
        draft = SkillDraft(
            name="测试技能",
            description="描述",
            steps=[{"order": 1, "action": "test", "tool": "t"}],
            tools_used=[],
        )
        assert draft.is_valid() is False

    def test_to_dict(self):
        draft = SkillDraft(
            name="测试",
            description="描述",
            steps=[{"order": 1}],
            tools_used=["t"],
            quality_score=0.85,
            reusability_score=0.7,
            expected_outcome="结果",
        )
        d = draft.to_dict()
        assert d["name"] == "测试"
        assert d["quality_score"] == 0.85
        assert d["reusability_score"] == 0.7
        assert d["expected_outcome"] == "结果"
        assert isinstance(d["steps"], list)
        assert isinstance(d["trigger_keywords"], list)
        assert isinstance(d["parameters"], dict)
        assert isinstance(d["preconditions"], dict)

    def test_default_values(self):
        draft = SkillDraft(name="test", description="desc")
        assert draft.trigger_keywords == []
        assert draft.steps == []
        assert draft.tools_used == []
        assert draft.parameters == {}
        assert draft.preconditions == {}
        assert draft.expected_outcome == ""
        assert draft.quality_score == 0.0
        assert draft.reusability_score == 0.0

    def test_to_dict_roundtrip(self):
        draft = SkillDraft(
            name="test",
            description="desc",
            trigger_keywords=["a"],
            steps=[{"order": 1}],
            tools_used=["t"],
        )
        d = draft.to_dict()
        draft2 = SkillDraft(**d)
        assert draft2.name == draft.name
        assert draft2.steps == draft.steps
