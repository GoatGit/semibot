"""Evolved skill retriever and formatter tests."""

import pytest
from unittest.mock import Mock, AsyncMock
from src.evolution.retriever import EvolvedSkillRetriever
from src.evolution.formatter import format_skills_for_prompt


class TestSkillRetriever:
    """进化技能检索测试"""

    @pytest.fixture
    def retriever(self):
        memory = Mock()
        memory.embed = AsyncMock(return_value=[0.1] * 1536)
        db = Mock()
        db.fetch = AsyncMock()
        return EvolvedSkillRetriever(memory, db)

    @pytest.mark.asyncio
    async def test_search_returns_results(self, retriever):
        retriever.db.fetch.return_value = [
            {"id": f"skill-{i}", "name": f"技能{i}", "similarity": 0.9 - i * 0.05,
             "description": f"描述{i}", "steps": [], "tools_used": [],
             "parameters": {}, "quality_score": 0.8,
             "use_count": 10, "success_count": 8}
            for i in range(3)
        ]

        results = await retriever.search(
            query="查询订单", org_id="org-001", limit=5
        )
        assert len(results) == 3

    @pytest.mark.asyncio
    async def test_search_empty_results(self, retriever):
        retriever.db.fetch.return_value = []

        results = await retriever.search(
            query="完全无关的查询", org_id="org-001", limit=5
        )
        assert len(results) == 0

    @pytest.mark.asyncio
    async def test_search_calls_embed(self, retriever):
        retriever.db.fetch.return_value = []
        await retriever.search(query="test", org_id="org-001", limit=5)
        retriever.memory.embed.assert_called_once_with("test")


class TestSkillFormatter:
    """技能格式化测试"""

    def test_format_empty_skills(self):
        result = format_skills_for_prompt([])
        assert result == ""

    def test_format_single_skill(self):
        skills = [{
            "id": "skill-001",
            "name": "查询订单",
            "description": "查询订单状态",
            "similarity": 0.92,
            "steps": [{"order": 1, "action": "查询"}],
            "use_count": 10,
            "success_count": 8,
        }]
        result = format_skills_for_prompt(skills)
        assert "查询订单" in result
        assert "0.92" in result
        assert "80%" in result
        assert "skill-001" in result

    def test_format_skill_zero_use_count(self):
        skills = [{
            "id": "skill-001",
            "name": "新技能",
            "description": "描述",
            "similarity": 0.8,
            "steps": [],
            "use_count": 0,
            "success_count": 0,
        }]
        result = format_skills_for_prompt(skills)
        assert "N/A" in result

    def test_format_multiple_skills(self):
        skills = [
            {"id": f"s-{i}", "name": f"技能{i}", "description": f"描述{i}",
             "similarity": 0.9 - i * 0.1, "steps": [], "use_count": i + 1, "success_count": i}
            for i in range(3)
        ]
        result = format_skills_for_prompt(skills)
        assert "技能 1" in result
        assert "技能 2" in result
        assert "技能 3" in result

    def test_format_includes_steps(self):
        skills = [{
            "id": "s-1",
            "name": "技能",
            "description": "描述",
            "similarity": 0.9,
            "steps": [
                {"order": 1, "action": "第一步"},
                {"order": 2, "action": "第二步"},
            ],
            "use_count": 5,
            "success_count": 4,
        }]
        result = format_skills_for_prompt(skills)
        assert "第一步" in result
        assert "第二步" in result
