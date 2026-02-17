"""Evolution metrics collector for Runtime side."""

from src.utils.logging import get_logger

logger = get_logger(__name__)


class EvolutionMetrics:
    """进化指标采集器"""

    def __init__(self, metrics_client=None):
        self.client = metrics_client

    def record_triggered(self, org_id: str, agent_id: str) -> None:
        """记录进化触发"""
        logger.info(
            "[Metrics] evolution_triggered",
            extra={"org_id": org_id, "agent_id": agent_id},
        )
        if self.client:
            self.client.increment(
                "evolution_triggered_total",
                labels={"org_id": org_id, "agent_id": agent_id},
            )

    def record_success(self, org_id: str, agent_id: str) -> None:
        """记录进化成功"""
        logger.info(
            "[Metrics] evolution_success",
            extra={"org_id": org_id, "agent_id": agent_id},
        )
        if self.client:
            self.client.increment(
                "evolution_success_total",
                labels={"org_id": org_id, "agent_id": agent_id},
            )

    def record_quality(self, org_id: str, quality_score: float) -> None:
        """记录技能质量"""
        if self.client:
            self.client.observe(
                "evolution_skill_quality",
                quality_score,
                labels={"org_id": org_id},
            )

    def record_reuse(self, org_id: str, skill_id: str) -> None:
        """记录技能复用"""
        if self.client:
            self.client.increment(
                "evolved_skill_reuse_total",
                labels={"org_id": org_id, "skill_id": skill_id},
            )

    def record_duration(self, org_id: str, stage: str, duration_seconds: float) -> None:
        """记录阶段耗时"""
        if self.client:
            self.client.observe(
                "evolution_duration_seconds",
                duration_seconds,
                labels={"org_id": org_id, "stage": stage},
            )

    def record_tokens(self, org_id: str, stage: str, tokens: int) -> None:
        """记录 Token 消耗"""
        if self.client:
            self.client.increment(
                "evolution_tokens_total",
                tokens,
                labels={"org_id": org_id, "stage": stage},
            )
