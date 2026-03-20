"""Evolved skill retriever for PLAN node integration."""

from src.utils.logging import get_logger

logger = get_logger(__name__)

EVOLUTION_SEARCH_SIMILARITY_THRESHOLD = 0.6


class EvolvedSkillRetriever:
    """进化技能检索器 — 在 PLAN 阶段检索相关进化技能"""

    def __init__(self, memory_system, db_pool):
        self.memory = memory_system
        self.db = db_pool

    async def search(
        self,
        query: str,
        org_id: str,
        limit: int = 5,
        status_filter: tuple = ("approved", "auto_approved"),
    ) -> list[dict]:
        """检索相关进化技能"""
        # 1. 生成查询 embedding
        embedding = await self.memory.embed(query)

        # 2. pgvector 相似度搜索
        results = await self.db.fetch(
            """SELECT id, name, description, steps, tools_used,
                      parameters, quality_score, use_count, success_count,
                      1 - (embedding <=> $1::vector) AS similarity
               FROM evolved_skills
               WHERE org_id = $2
                 AND status = ANY($3::text[])
                 AND deleted_at IS NULL
                 AND embedding IS NOT NULL
                 AND 1 - (embedding <=> $1::vector) >= $4
               ORDER BY similarity DESC
               LIMIT $5""",
            embedding, org_id, list(status_filter),
            EVOLUTION_SEARCH_SIMILARITY_THRESHOLD, limit,
        )

        return [dict(row) for row in results]
