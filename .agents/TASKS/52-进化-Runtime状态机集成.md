# 任务：进化系统 — Runtime 状态机集成

**优先级**: 🟡 P1 - 重要
**类型**: 功能实现
**预估工时**: 2-3 天
**影响范围**: runtime/src/agent/nodes/、runtime/src/agent/state.py

---

## 问题描述

EvolutionEngine 核心实现完成后，需要将其集成到 LangGraph 状态机中。具体包括：修改 `reflect_node` 在反思完成后调用 `EvolutionEngine.maybe_evolve()`，修改 `plan_node` 在规划前检索进化技能，以及扩展 `AgentState` 类型以支持进化相关字段。

---

## 详细实现

### 1. AgentState 类型扩展

```python
# runtime/src/agent/state.py — 新增字段

from typing import TypedDict, Optional

class AgentState(TypedDict):
    # ... 现有字段 ...

    # 进化相关
    evolved_skill_refs: list[dict]          # 当前计划引用的进化技能
    evolution_triggered: bool                # 本轮是否触发了进化
```

### 2. reflect_node 集成

```python
# runtime/src/agent/nodes/reflect_node.py — 修改

from src.evolution.engine import EvolutionEngine


async def reflect_node(state: AgentState) -> AgentState:
    """REFLECT 节点 — 反思总结 + 异步触发进化"""

    # === 现有反思逻辑 ===
    reflection = await _generate_reflection(state)
    new_state = {**state, "reflection": reflection}

    # === 新增：异步触发进化 ===
    try:
        evolution_engine = _get_evolution_engine(state)
        if evolution_engine:
            await evolution_engine.maybe_evolve(new_state)
            new_state["evolution_triggered"] = True
    except Exception as e:
        # 进化失败不影响主流程
        logger.error(f"[Evolution] 触发进化异常（不影响主流程）: {e}")
        new_state["evolution_triggered"] = False

    return new_state


def _get_evolution_engine(state: AgentState) -> EvolutionEngine | None:
    """获取 EvolutionEngine 实例（如果可用）"""
    # 从 state 中获取依赖
    llm = state.get("llm_provider")
    memory = state.get("memory_system")
    skill_registry = state.get("skill_registry")
    db_pool = state.get("db_pool")

    if not all([llm, memory, skill_registry, db_pool]):
        return None

    return EvolutionEngine(llm, memory, skill_registry, db_pool)
```

### 3. plan_node 集成进化技能检索

```python
# runtime/src/agent/nodes/plan_node.py — 修改

from src.evolution.retriever import EvolvedSkillRetriever
from src.evolution.formatter import format_skills_for_prompt

EVOLUTION_SKILL_SEARCH_LIMIT = 5
EVOLUTION_SKILL_MIN_STATUS = ("approved", "auto_approved")


async def plan_node(state: AgentState) -> AgentState:
    """PLAN 节点 — 集成进化技能检索"""

    # === 新增：检索进化技能 ===
    evolved_skills_context = ""
    evolved_skill_refs = []

    evolution_config = state.get("agent_config", {}).get("evolution", {})
    if evolution_config.get("enabled", False):
        try:
            user_intent = state["messages"][-1]["content"]
            relevant_skills = await _search_evolved_skills(
                query=user_intent,
                agent_id=state["agent_id"],
                org_id=state["org_id"],
                limit=EVOLUTION_SKILL_SEARCH_LIMIT,
            )

            if relevant_skills:
                evolved_skills_context = format_skills_for_prompt(relevant_skills)
                logger.info(
                    f"[Evolution] 检索到 {len(relevant_skills)} 个相关进化技能"
                )
        except Exception as e:
            logger.error(f"[Evolution] 技能检索异常（不影响规划）: {e}")

    # === 现有规划逻辑（注入进化技能上下文）===
    plan = await _generate_plan(
        state,
        available_evolved_skills=evolved_skills_context,
    )

    # === 新增：记录引用的进化技能 ===
    evolved_skill_refs = plan.get("evolved_skill_refs", [])
    for skill_ref in evolved_skill_refs:
        await _increment_skill_use_count(skill_ref["id"])

    return {
        **state,
        "plan": plan,
        "evolved_skill_refs": evolved_skill_refs,
    }


async def _search_evolved_skills(
    query: str, agent_id: str, org_id: str, limit: int
) -> list[dict]:
    """检索相关进化技能"""
    retriever = EvolvedSkillRetriever(...)
    return await retriever.search(
        query=query,
        org_id=org_id,
        limit=limit,
        status_filter=EVOLUTION_SKILL_MIN_STATUS,
    )


async def _increment_skill_use_count(skill_id: str) -> None:
    """更新技能使用计数"""
    # 调用 Repository 的 incrementUseCount
    ...
```

### 4. observe_node 复用成功判断

```python
# runtime/src/agent/nodes/observe_node.py — 修改

async def observe_node(state: AgentState) -> AgentState:
    """OBSERVE 节点 — 新增复用成功判断"""

    # === 现有观察逻辑 ===
    observation = await _observe(state)

    # === 新增：如果使用了进化技能，判断是否成功并更新计数 ===
    evolved_skill_refs = state.get("evolved_skill_refs", [])
    if evolved_skill_refs and observation.get("success", False):
        for skill_ref in evolved_skill_refs:
            try:
                await _increment_skill_success_count(skill_ref["id"])
                logger.info(
                    f"[Evolution] 进化技能复用成功 (id={skill_ref['id']})"
                )
            except Exception as e:
                logger.error(
                    f"[Evolution] 更新成功计数失败: {e}"
                )

    return {**state, "observation": observation}
```

### 5. 进化技能检索器

```python
# runtime/src/evolution/retriever.py

from src.utils.logging import get_logger

logger = get_logger(__name__)

EVOLUTION_SEARCH_SIMILARITY_THRESHOLD = 0.6


class EvolvedSkillRetriever:
    """进化技能检索器"""

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
                 AND 1 - (embedding <=> $1::vector) >= $4
               ORDER BY similarity DESC
               LIMIT $5""",
            embedding, org_id, list(status_filter),
            EVOLUTION_SEARCH_SIMILARITY_THRESHOLD, limit
        )

        return [dict(row) for row in results]
```

### 6. 技能上下文格式化

```python
# runtime/src/evolution/formatter.py


def format_skills_for_prompt(skills: list[dict]) -> str:
    """将进化技能格式化为 LLM prompt 上下文"""
    if not skills:
        return ""

    lines = ["## 可复用的进化技能\n"]
    for i, skill in enumerate(skills, 1):
        use_count = skill.get("use_count", 0)
        success_count = skill.get("success_count", 0)
        success_rate = (
            f"{success_count / use_count:.0%}" if use_count > 0 else "N/A"
        )

        lines.append(f"### 技能 {i}: {skill['name']} (相似度: {skill.get('similarity', 0):.2f})")
        lines.append(f"描述: {skill['description']}")
        lines.append(f"步骤: {_format_steps(skill.get('steps', []))}")
        lines.append(f"使用次数: {use_count}, 成功率: {success_rate}")
        lines.append(f"技能ID: {skill['id']}")
        lines.append("")

    return "\n".join(lines)


def _format_steps(steps: list[dict]) -> str:
    """格式化步骤列表"""
    if not steps:
        return "无"
    return " → ".join(
        f"{s.get('order', i+1)}. {s.get('action', '未知')}"
        for i, s in enumerate(steps)
    )
```

---

## 修复清单

- [ ] 扩展 `AgentState` 类型，新增 `evolved_skill_refs`、`evolution_triggered` 字段
- [ ] 修改 `reflect_node`，在反思完成后调用 `EvolutionEngine.maybe_evolve()`
- [ ] 修改 `plan_node`，在规划前检索进化技能并注入 LLM 上下文
- [ ] 修改 `observe_node`，判断进化技能复用是否成功并更新计数
- [ ] 创建 `runtime/src/evolution/retriever.py` — 进化技能检索器
- [ ] 创建 `runtime/src/evolution/formatter.py` — 技能上下文格式化
- [ ] 确保进化相关异常不传播到主流程（try-catch 包裹）
- [ ] 所有检索包含 `org_id` 租户隔离
- [ ] 边界检查添加日志

---

## 完成标准

- [ ] reflect_node 正确触发异步进化
- [ ] plan_node 能检索并注入进化技能上下文
- [ ] observe_node 正确更新复用成功计数
- [ ] 进化异常不影响主流程（RESPOND 正常返回）
- [ ] AgentState 类型扩展向后兼容
- [ ] 代码审查通过

---

## 相关文档

- [进化系统设计](docs/design/EVOLUTION.md) 第 2、3、5 节
- [PRD: 进化 Runtime 引擎](.agents/PRDS/evolution-runtime-engine.md)
- [PRD: 进化技能复用](.agents/PRDS/evolution-skill-reuse.md)
