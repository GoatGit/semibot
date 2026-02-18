"""Evolution Engine — Agent self-learning core.

Runs asynchronously after REFLECT to extract reusable skills from successful executions.
Pipeline: EXTRACT → VALIDATE → REGISTER → INDEX
"""

import asyncio
import json
import time
import uuid

import redis.asyncio as redis

from src.utils.logging import get_logger
from src.evolution.models import SkillDraft
from src.evolution.prompts import EXTRACT_PROMPT, QUALITY_ASSESS_PROMPT
from src.evolution.validators import SafetyChecker

logger = get_logger(__name__)

# ═══════════════════════════════════════════════════════════════
# 常量
# ═══════════════════════════════════════════════════════════════

EVOLUTION_MIN_STEP_COUNT = 3
EVOLUTION_DEDUP_THRESHOLD = 0.85
EVOLUTION_AUTO_APPROVE_THRESHOLD = 0.8
EVOLUTION_DEFAULT_MIN_QUALITY = 0.6
EVOLUTION_RECENT_MESSAGES_LIMIT = 10

# 冷却期默认配置
EVOLUTION_DEFAULT_COOLDOWN_WINDOW = 3600  # 1 小时（秒）
EVOLUTION_DEFAULT_MAX_PER_WINDOW = 5      # 每窗口最大进化次数

# Redis Lua 脚本：原子性检查冷却期并记录进化
EVOLUTION_COOLDOWN_SCRIPT = """
local key = KEYS[1]
local now = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local max_count = tonumber(ARGV[3])
local entry_id = ARGV[4]

-- 清理窗口外的过期记录
redis.call('ZREMRANGEBYSCORE', key, 0, now - window)

-- 检查当前窗口内的次数
local count = redis.call('ZCARD', key)
if count >= max_count then
    return 0
end

-- 记录本次进化
redis.call('ZADD', key, now, entry_id)
redis.call('EXPIRE', key, window)
return 1
"""


class EvolutionEngine:
    """进化引擎 — REFLECT 之后异步执行"""

    def __init__(self, llm, memory_system, skill_registry, db_pool,
                 redis_client: redis.Redis | None = None):
        self.llm = llm
        self.memory = memory_system
        self.skill_registry = skill_registry
        self.db = db_pool
        self.safety_checker = SafetyChecker()
        self._redis = redis_client
        self._cooldown_script_sha: str | None = None

    async def maybe_evolve(self, state: dict) -> None:
        """条件判断 + 异步触发进化（fire-and-forget）"""
        if not await self._should_evolve(state):
            return

        asyncio.create_task(self._safe_evolve(state))

    async def _safe_evolve(self, state: dict) -> None:
        """包裹 _evolve，确保异常不传播"""
        try:
            await self._evolve(state)
        except Exception as e:
            logger.error(f"[Evolution] 异步进化异常: {e}")

    async def _should_evolve(self, state: dict) -> bool:
        """判断是否触发进化"""
        reflection = state.get("reflection", {})

        # 1. 任务必须成功
        if not reflection.get("success", False):
            logger.debug("[Evolution] 跳过：任务未成功")
            return False

        # 2. 多步骤任务（step_count >= 3）
        tool_results = state.get("tool_results", [])
        if len(tool_results) < EVOLUTION_MIN_STEP_COUNT:
            logger.debug(
                f"[Evolution] 跳过：步骤数不足 "
                f"(当前: {len(tool_results)}, 要求: {EVOLUTION_MIN_STEP_COUNT})"
            )
            return False

        # 3. 进化开关
        evolution_config = state.get("agent_config", {}).get("evolution", {})
        if not evolution_config.get("enabled", False):
            logger.debug("[Evolution] 跳过：进化未启用")
            return False

        # 4. 冷却检查
        if not await self._check_cooldown(state.get("agent_id", ""), evolution_config):
            logger.debug(
                f"[Evolution] 跳过：冷却期内 (agent_id={state.get('agent_id')})"
            )
            return False

        # 5. 频率限制
        if not await self._check_rate_limit(state.get("agent_id", ""), evolution_config):
            logger.debug(
                f"[Evolution] 跳过：频率超限 (agent_id={state.get('agent_id')})"
            )
            return False

        return True

    async def _evolve(self, state: dict) -> None:
        """完整进化流程: EXTRACT → VALIDATE → REGISTER → INDEX"""
        start_time = time.time()
        try:
            # EXTRACT
            await self._log_stage(state, "extract", "started")
            draft = await self._extract(state)
            if not draft:
                await self._log_stage(
                    state, "extract", "failed",
                    error_message="提取失败：无法解析技能草稿",
                )
                return
            await self._log_stage(
                state, "extract", "completed",
                output_data=draft.to_dict(),
            )

            # VALIDATE
            await self._log_stage(state, "validate", "started")
            validated = await self._validate(draft, state)
            if not validated:
                await self._log_stage(
                    state, "validate", "failed",
                    error_message="验证未通过",
                )
                return
            await self._log_stage(
                state, "validate", "completed",
                output_data={"quality_score": draft.quality_score},
            )

            # REGISTER
            await self._log_stage(state, "register", "started")
            skill_id = await self._register(draft, state)
            await self._log_stage(
                state, "register", "completed",
                evolved_skill_id=skill_id,
            )

            # INDEX
            await self._log_stage(state, "index", "started")
            await self._index(skill_id, draft)
            await self._log_stage(
                state, "index", "completed",
                evolved_skill_id=skill_id,
            )

            duration = time.time() - start_time
            logger.info(
                f"[Evolution] 进化完成 "
                f"(skill={draft.name}, quality={draft.quality_score:.2f}, "
                f"duration={duration:.1f}s)"
            )

        except Exception as e:
            logger.error(f"[Evolution] 进化流程异常: {e}")
            await self._log_evolution_error(state, str(e))

    async def _extract(self, state: dict) -> SkillDraft | None:
        """EXTRACT — 从执行过程中提取技能"""
        prompt = EXTRACT_PROMPT.format(
            reflection=state.get("reflection", {}),
            plan=state.get("plan", {}),
            tool_results=state.get("tool_results", []),
            messages=state.get("messages", [])[-EVOLUTION_RECENT_MESSAGES_LIMIT:],
        )

        result = await self.llm.chat([
            {"role": "system", "content": "你是一个技能提取专家，擅长从执行记录中提炼可复用的技能模式。"},
            {"role": "user", "content": prompt},
        ])

        return self._parse_skill_draft(result)

    async def _validate(self, draft: SkillDraft, state: dict) -> bool:
        """VALIDATE — 验证技能草稿"""
        # 1. 完整性检查
        if not draft.is_valid():
            logger.warning(f"[Evolution] 技能草稿不完整: {draft.name}")
            return False

        # 2. 安全检查
        safety_result = self.safety_checker.check(draft)
        if not safety_result.is_safe:
            logger.warning(
                f"[Evolution] 安全检查未通过: {draft.name}, "
                f"原因: {safety_result.reason}"
            )
            return False

        # 3. 去重检查
        similar = await self.memory.search_evolved_skills(
            draft.description, threshold=EVOLUTION_DEDUP_THRESHOLD
        )
        if similar:
            logger.info(
                f"[Evolution] 技能已存在相似项，跳过 "
                f"(name={draft.name}, similar={similar[0].get('name', 'unknown')})"
            )
            return False

        # 4. 质量评估
        quality = await self._assess_quality(draft)
        draft.quality_score = quality.get("score", 0.0)
        draft.reusability_score = quality.get("reusability", 0.0)

        # 5. 准入门槛
        evolution_config = state.get("agent_config", {}).get("evolution", {})
        min_quality = evolution_config.get(
            "min_quality_score", EVOLUTION_DEFAULT_MIN_QUALITY
        )
        if draft.quality_score < min_quality:
            logger.info(
                f"[Evolution] 质量评分不足 "
                f"(score={draft.quality_score:.2f}, min={min_quality})"
            )
            return False

        return True

    async def _register(self, draft: SkillDraft, state: dict) -> str:
        """REGISTER — 注册技能到数据库"""
        evolution_config = state.get("agent_config", {}).get("evolution", {})

        # 状态判定
        status = "auto_approved" if (
            draft.quality_score >= EVOLUTION_AUTO_APPROVE_THRESHOLD
            and evolution_config.get("auto_approve", False)
        ) else "pending_review"

        skill_id = await self.db.execute(
            """INSERT INTO evolved_skills
               (org_id, agent_id, session_id, name, description,
                trigger_keywords, steps, tools_used, parameters,
                preconditions, expected_outcome, quality_score,
                reusability_score, status)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
               RETURNING id""",
            state["org_id"], state["agent_id"], state["session_id"],
            draft.name, draft.description, draft.trigger_keywords,
            json.dumps(draft.steps), json.dumps(draft.tools_used),
            json.dumps(draft.parameters), json.dumps(draft.preconditions),
            draft.expected_outcome, draft.quality_score,
            draft.reusability_score, status,
        )

        logger.info(
            f"[Evolution] 技能已注册 "
            f"(id={skill_id}, name={draft.name}, status={status})"
        )
        return skill_id

    async def _index(self, skill_id: str, draft: SkillDraft) -> None:
        """INDEX — 生成向量索引"""
        embedding = await self.llm.embed(draft.description)
        await self.db.execute(
            "UPDATE evolved_skills SET embedding = $1 WHERE id = $2",
            embedding, skill_id,
        )

        await self.skill_registry.refresh_cache()

    def _parse_skill_draft(self, llm_result: str) -> SkillDraft | None:
        """解析 LLM 输出为 SkillDraft"""
        try:
            data = json.loads(llm_result)
            return SkillDraft(
                name=data["name"],
                description=data["description"],
                trigger_keywords=data.get("trigger_keywords", []),
                steps=data.get("steps", []),
                tools_used=data.get("tools_used", []),
                parameters=data.get("parameters", {}),
                preconditions=data.get("preconditions", {}),
                expected_outcome=data.get("expected_outcome", ""),
                reusability_score=data.get("reusability_score", 0.0),
            )
        except (json.JSONDecodeError, KeyError) as e:
            logger.error(f"[Evolution] 解析技能草稿失败: {e}")
            return None

    async def _assess_quality(self, draft: SkillDraft) -> dict:
        """LLM 评估技能质量"""
        prompt = QUALITY_ASSESS_PROMPT.format(
            name=draft.name,
            description=draft.description,
            steps=json.dumps(draft.steps, ensure_ascii=False),
            tools_used=draft.tools_used,
        )

        try:
            result = await self.llm.chat([
                {"role": "system", "content": "你是一个技能质量评估专家。"},
                {"role": "user", "content": prompt},
            ])
            return json.loads(result)
        except (json.JSONDecodeError, Exception) as e:
            logger.error(f"[Evolution] 质量评估失败: {e}")
            return {"score": 0.5, "reusability": 0.5}

    async def _check_cooldown(self, agent_id: str, config: dict) -> bool:
        """检查冷却时间 — Redis ZSET + Lua 脚本原子操作"""
        if self._redis is None:
            logger.warning("[Evolution] Redis 不可用，冷却期检查降级为允许")
            return True

        window = config.get("cooldown_window", EVOLUTION_DEFAULT_COOLDOWN_WINDOW)
        max_count = config.get("max_per_window", EVOLUTION_DEFAULT_MAX_PER_WINDOW)
        key = f"evolution:cooldown:{agent_id}"
        now = time.time()
        entry_id = str(uuid.uuid4())

        try:
            result = await self._redis.eval(
                EVOLUTION_COOLDOWN_SCRIPT,
                1,
                key,
                str(now),
                str(window),
                str(max_count),
                entry_id,
            )
            allowed = int(result) == 1
            if not allowed:
                logger.warning(
                    f"[Evolution] 冷却期内，拒绝进化 "
                    f"(agent_id={agent_id}, window={window}s, max={max_count})"
                )
            return allowed
        except Exception as e:
            logger.warning(f"[Evolution] Redis 冷却期检查异常，降级为允许: {e}")
            return True

    async def _check_rate_limit(self, agent_id: str, config: dict) -> bool:
        """检查频率限制 — 复用冷却期 ZSET，仅做只读检查"""
        if self._redis is None:
            logger.warning("[Evolution] Redis 不可用，频率限制检查降级为允许")
            return True

        window = config.get("cooldown_window", EVOLUTION_DEFAULT_COOLDOWN_WINDOW)
        max_count = config.get("max_per_window", EVOLUTION_DEFAULT_MAX_PER_WINDOW)
        key = f"evolution:cooldown:{agent_id}"
        now = time.time()

        try:
            # 只读检查：统计窗口内的记录数
            count = await self._redis.zcount(key, now - window, "+inf")
            allowed = count < max_count
            if not allowed:
                logger.warning(
                    f"[Evolution] 频率超限 "
                    f"(agent_id={agent_id}, current={count}, max={max_count})"
                )
            return allowed
        except Exception as e:
            logger.warning(f"[Evolution] Redis 频率限制检查异常，降级为允许: {e}")
            return True

    async def _log_stage(
        self,
        state: dict,
        stage: str,
        status: str,
        evolved_skill_id: str | None = None,
        output_data: dict | None = None,
        error_message: str | None = None,
    ) -> None:
        """记录进化阶段日志"""
        try:
            await self.db.execute(
                """INSERT INTO evolution_logs
                   (org_id, agent_id, session_id, stage, status,
                    evolved_skill_id, output_data, error_message)
                   VALUES ($1,$2,$3,$4,$5,$6,$7,$8)""",
                state.get("org_id"), state.get("agent_id"),
                state.get("session_id"), stage, status,
                evolved_skill_id,
                json.dumps(output_data) if output_data else None,
                error_message,
            )
        except Exception as e:
            logger.error(f"[Evolution] 日志写入失败: {e}")

    async def _log_evolution_error(self, state: dict, error: str) -> None:
        """记录进化流程错误"""
        await self._log_stage(
            state, "extract", "failed",
            error_message=error,
        )
