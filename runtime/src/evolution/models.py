"""Evolution data models."""

from dataclasses import dataclass, field


@dataclass
class SkillDraft:
    """进化技能草稿 — 从执行记录中提取的可复用技能定义"""

    name: str
    description: str
    trigger_keywords: list[str] = field(default_factory=list)
    steps: list[dict] = field(default_factory=list)
    tools_used: list[str] = field(default_factory=list)
    parameters: dict = field(default_factory=dict)
    preconditions: dict = field(default_factory=dict)
    expected_outcome: str = ""
    quality_score: float = 0.0
    reusability_score: float = 0.0

    def is_valid(self) -> bool:
        """完整性检查：所有必填字段非空"""
        return bool(
            self.name
            and self.description
            and self.steps
            and self.tools_used
        )

    def to_dict(self) -> dict:
        """序列化为字典"""
        return {
            "name": self.name,
            "description": self.description,
            "trigger_keywords": self.trigger_keywords,
            "steps": self.steps,
            "tools_used": self.tools_used,
            "parameters": self.parameters,
            "preconditions": self.preconditions,
            "expected_outcome": self.expected_outcome,
            "quality_score": self.quality_score,
            "reusability_score": self.reusability_score,
        }
