# 任务：进化系统 — EvolutionEngine 核心实现

**优先级**: 🔴 P0 - 严重
**类型**: 功能实现
**预估工时**: 3-5 天
**影响范围**: runtime/src/evolution/ 目录

---

## 问题描述

进化系统的核心引擎 `EvolutionEngine` 需要从零实现，包括 SkillDraft 数据类、触发条件判断、EXTRACT/VALIDATE/REGISTER/INDEX 四阶段流水线、EXTRACT_PROMPT 模板。这是进化系统 Runtime 侧的核心组件。

---

## 模块概述

**需要创建的文件**:
- `runtime/src/evolution/__init__.py` — 模块初始化
- `runtime/src/evolution/engine.py` — EvolutionEngine 核心类
- `runtime/src/evolution/models.py` — SkillDraft 数据类
- `runtime/src/evolution/prompts.py` — EXTRACT_PROMPT 等提示词模板
- `runtime/src/evolution/validators.py` — 安全检查、完整性检查

---

## 详细实现

### 1. SkillDraft 数据类

```python
# runtime/src/evolution/models.py

from dataclasses import dataclass, field


@dataclass
class SkillDraft:
    """进化技能草稿"""
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
```

### 2. EvolutionEngine 核心类

```python
# runtime/src/evolution/engine.py

import asyncio
import time
from src.utils.logging import get_logger
from src.evolution.models import SkillDraft
from src.evolution.prompts import EXTRACT_PROMPT
from src.evolution.validators import SafetyChecker

logger = get_logger(__name__)

# 常量定义
EVOLUTION_MIN_STEP_COUNT = 3
EVOLUTION_DEDUP_THRESHOLD = 0.85
EVOLUTION_AUTO_APPROVE_THRESHOLD = 0.8
EVOLUTION_DEFAULT_MIN_QUALITY = 0.6
EVOLUTION_RECENT_MESSAGES_LIMIT = 10


class EvolutionEngine:
    """进化引擎 — REFLECT 之后异步执行"""

    def __init__(self, llm, memory_system, skill_registry, db_pool):
        self.llm = llm
        self.memory = memory_system
        self.skill_registry = skill_registry
        self.db = db_pool
        self.safety_checker = SafetyChecker()

    async def maybe_evolve(self, state: dict) -> None:
        """条件判断 + 异步触发进化"""
        if not self._should_evolve(state):
            return

        # Fire-and-forget: 不阻塞主流程
        asyncio.create_task(self._evolve(state))

    def _should_evolve(self, state: dict) -> bool:
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
        if not self._check_cooldown(state["agent_id"], evolution_config):
            logger.warn(
                f"[Evolution] 跳过：冷却期内 "
                f"(agent_id={state['agent_id']})"
            )
            return False

        # 5. 频率限制
        if not self._check_rate_limit(state["agent_id"], evolution_config):
            logger.warn(
                f"[Evolution] 跳过：频率超限 "
                f"(agent_id={state['agent_id']})"
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
                await self._log_stage(state, "extract", "failed",
                                      error_message="提取失败：无法解析技能草稿")
                return
            await self._log_stage(state, "extract", "completed",
                                  output_data=draft.to_dict())

            # VALIDATE
            await self._log_stage(state, "validate", "started")
            validated = await self._validate(draft, state)
            if not validated:
                await self._log_stage(state, "validate", "failed",
                                      error_message="验证未通过")
                return
            await self._log_stage(state, "validate", "completed",
                                  output_data={"quality_score": draft.quality_score})

            # REGISTER
            await self._log_stage(state, "register", "started")
            skill_id = await self._register(draft, state)
            await self._log_stage(state, "register", "completed",
                                  evolved_skill_id=skill_id)

            # INDEX
            await self._log_stage(state, "index", "started")
            await self._index(skill_id, draft)
            await self._log_stage(state, "index", "completed",
                                  evolved_skill_id=skill_id)

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
            reflection=state["reflection"],
            plan=state["plan"],
            tool_results=state["tool_results"],
            messages=state["messages"][-EVOLUTION_RECENT_MESSAGES_LIMIT:]
        )

        result = await self.llm.chat([
            {"role": "system", "content": "你是一个技能提取专家，擅长从执行记录中提炼可复用的技能模式。"},
            {"role": "user", "content": prompt}
        ])

        return self._parse_skill_draft(result)

    async def _validate(self, draft: SkillDraft, state: dict) -> bool:
        """VALIDATE — 验证技能草稿"""
        # 1. 完整性检查
        if not draft.is_valid():
            logger.warn(f"[Evolution] 技能草稿不完整: {draft.name}")
            return False

        # 2. 安全检查
        safety_result = self.safety_checker.check(draft)
        if not safety_result.is_safe:
            logger.warn(
                f"[Evolution] 安全检查未通过: {draft.name}, "
                f"原因: {safety_result.reason}"
            )
            return False

        # 3. 去重检查: embedding 相似度 > 0.85 则跳过
        similar = await self.memory.search_evolved_skills(
            draft.description, threshold=EVOLUTION_DEDUP_THRESHOLD
        )
        if similar:
            logger.info(
                f"[Evolution] 技能已存在相似项，跳过 "
                f"(name={draft.name}, similar={similar[0]['name']})"
            )
            return False

        # 4. 质量评估
        quality = await self._assess_quality(draft)
        draft.quality_score = quality["score"]
        draft.reusability_score = quality["reusability"]

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
        evolution_config = state["agent_config"].get("evolution", {})

        # 状态判定
        status = "auto_approved" if (
            draft.quality_score >= EVOLUTION_AUTO_APPROVE_THRESHOLD
            and evolution_config.get("auto_approve", False)
        ) else "pending_review"

        # 写入 evolved_skills 表
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
            draft.steps, draft.tools_used, draft.parameters,
            draft.preconditions, draft.expected_outcome,
            draft.quality_score, draft.reusability_score, status
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
            embedding, skill_id
        )

        # 更新 SkillRegistry 缓存
        await self.skill_registry.refresh_cache()

    def _parse_skill_draft(self, llm_result: str) -> SkillDraft | None:
        """解析 LLM 输出为 SkillDraft"""
        import json
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
        # 调用 LLM 评估通用性和可复用性
        # 返回 {"score": float, "reusability": float}
        ...

    def _check_cooldown(self, agent_id: str, config: dict) -> bool:
        """检查冷却时间"""
        # 从 Redis 获取上次进化时间戳
        ...

    def _check_rate_limit(self, agent_id: str, config: dict) -> bool:
        """检查频率限制"""
        # 从 Redis 获取当前小时进化次数
        ...

    async def _log_stage(self, state: dict, stage: str, status: str,
                         evolved_skill_id: str = None,
                         output_data: dict = None,
                         error_message: str = None) -> None:
        """记录进化阶段日志"""
        await self.db.execute(
            """INSERT INTO evolution_logs
               (org_id, agent_id, session_id, stage, status,
                evolved_skill_id, output_data, error_message)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8)""",
            state["org_id"], state["agent_id"], state["session_id"],
            stage, status, evolved_skill_id, output_data, error_message
        )

    async def _log_evolution_error(self, state: dict, error: str) -> None:
        """记录进化流程错误"""
        logger.error(f"[Evolution] 进化失败: {error}")
        await self._log_stage(state, "extract", "failed",
                              error_message=error)
```

### 3. EXTRACT_PROMPT 模板

```python
# runtime/src/evolution/prompts.py

EXTRACT_PROMPT = """
基于以下 Agent 执行记录，提取一个可复用的技能定义。

## 执行反思
{reflection}

## 执行计划
{plan}

## 工具调用结果
{tool_results}

## 对话上下文
{messages}

请以 JSON 格式输出技能定义：
{{
    "name": "技能名称（简洁、动词开头）",
    "description": "技能描述（一句话说明用途）",
    "trigger_keywords": ["触发关键词1", "关键词2"],
    "steps": [
        {{"order": 1, "action": "动作描述", "tool": "工具名", "params_template": {{}}}}
    ],
    "tools_used": ["tool1", "tool2"],
    "parameters": {{
        "param_name": {{"type": "string", "description": "参数说明", "required": true}}
    }},
    "preconditions": {{
        "required_tools": ["tool1"],
        "description": "前置条件说明"
    }},
    "expected_outcome": "预期结果描述",
    "reusability_score": 0.8
}}

注意：
1. 只提取具有通用复用价值的技能，不要提取一次性的特定任务
2. 参数化所有可变部分，使技能可以适用于不同输入
3. 步骤描述要足够清晰，让其他 Agent 也能执行
"""

QUALITY_ASSESS_PROMPT = """
评估以下技能的质量和复用价值。

技能名称: {name}
技能描述: {description}
执行步骤: {steps}
使用工具: {tools_used}

请以 JSON 格式输出评估结果：
{{
    "score": 0.0-1.0,
    "reusability": 0.0-1.0,
    "reasoning": "评估理由"
}}

评估维度：
1. 通用性 — 是否适用于多种场景
2. 完整性 — 步骤是否完整可执行
3. 参数化 — 可变部分是否已参数化
4. 清晰度 — 描述和步骤是否清晰
"""
```

### 4. 安全检查器

```python
# runtime/src/evolution/validators.py

from dataclasses import dataclass
from src.utils.logging import get_logger

logger = get_logger(__name__)

DANGEROUS_PATTERNS = [
    "rm -rf", "DROP TABLE", "DELETE FROM", "TRUNCATE",
    "os.system", "subprocess", "eval(", "exec(",
    "format(", "__import__",
]

DANGEROUS_TOOLS = [
    "shell_exec", "file_delete", "database_drop",
]


@dataclass
class SafetyResult:
    is_safe: bool
    reason: str = ""


class SafetyChecker:
    """技能安全检查器"""

    def check(self, draft) -> SafetyResult:
        """检查技能草稿的安全性"""
        # 检查步骤中的危险模式
        for step in draft.steps:
            action = str(step.get("action", ""))
            params = str(step.get("params_template", {}))
            combined = f"{action} {params}"

            for pattern in DANGEROUS_PATTERNS:
                if pattern.lower() in combined.lower():
                    return SafetyResult(
                        is_safe=False,
                        reason=f"步骤包含危险操作: {pattern}"
                    )

        # 检查危险工具
        for tool in draft.tools_used:
            if tool in DANGEROUS_TOOLS:
                return SafetyResult(
                    is_safe=False,
                    reason=f"使用了危险工具: {tool}"
                )

        return SafetyResult(is_safe=True)
```

---

## 修复清单

- [ ] 创建 `runtime/src/evolution/__init__.py`
- [ ] 创建 `runtime/src/evolution/models.py` — SkillDraft 数据类
- [ ] 创建 `runtime/src/evolution/engine.py` — EvolutionEngine 核心类
- [ ] 创建 `runtime/src/evolution/prompts.py` — EXTRACT_PROMPT + QUALITY_ASSESS_PROMPT
- [ ] 创建 `runtime/src/evolution/validators.py` — SafetyChecker
- [ ] 实现 `_should_evolve` 全部 5 个触发条件
- [ ] 实现 `_extract` LLM 调用和解析
- [ ] 实现 `_validate` 完整性/去重/安全/质量检查
- [ ] 实现 `_register` 状态判定和数据库写入
- [ ] 实现 `_index` 向量生成和缓存刷新
- [ ] 实现 `_check_cooldown` 和 `_check_rate_limit`（Redis）
- [ ] 实现 `_log_stage` 进化日志记录
- [ ] 所有边界检查添加日志

---

## 完成标准

- [ ] EvolutionEngine 通过构造函数注入依赖
- [ ] `maybe_evolve` 使用 `asyncio.create_task` 不阻塞主流程
- [ ] 所有触发条��正确实现
- [ ] 四阶段流水线完整可执行
- [ ] 每个阶段独立写入 evolution_logs
- [ ] 异常不传播到主流程
- [ ] 代码审查通过

---

## 相关文档

- [进化系统设计](docs/design/EVOLUTION.md) 第 2、3、5 节
- [编码规范](.claude/rules/coding-standards.md)
- [PRD: 进化 Runtime 引擎](.agents/PRDS/evolution-runtime-engine.md)
