# Semibot: 进化系统 — Runtime 引擎

**Priority:** High
**Status:** Not Started
**Type:** Feature
**Created:** 2026-02-17
**Last Updated:** 2026-02-17

## Overview

实现进化系统的 Python Runtime 核心引擎，包括 EvolutionEngine 类、EVOLVE 异步节点、触发条件判断、EXTRACT/VALIDATE/REGISTER/INDEX 四阶段流水线，以及与 reflect_node 的集成。

## Description

EvolutionEngine 是进化系统的核心组件，在 REFLECT 节点之后异步执行。它负责判断是否触发进化、从执行过程中提取技能草稿、验证技能质量和去重、注册到数据库、生成向量索引。整个流程作为 fire-and-forget 异步任务执行，不阻塞主流程。

参考设计文档：`docs/design/EVOLUTION.md` 第 2、3、5 节。

## Features / Requirements

### 1. EvolutionEngine 类

- 构造函数依赖注入：`llm`、`memory_system`、`skill_registry`、`db_pool`
- `maybe_evolve(state)` — 条件判断 + 异步触发入口
- `_evolve(state)` — 完整进化流程编排
- 所有阶段独立记录 `evolution_logs`，���一阶段失败终止流程并记录错误

### 2. _should_evolve 触发条件

按顺序检查以下全部条件：

| 条件 | 说明 | 阈值 |
|------|------|------|
| 任务成功 | `reflection.success = true` | 必须 |
| 多步骤任务 | `step_count >= 3` | 工具调用次数 |
| 进化开关 | `evolution.enabled = true` | Agent 配置 |
| 冷却检查 | 距上次进化 >= `cooldown_minutes` | Redis 时间戳 |
| 频率限制 | 当前小时进化次数 < `max_evolve_per_hour` | Redis 计数器 |

### 3. EXTRACT 阶段 — 技能提取

- 输入：REFLECT 反思总结 + execution_logs + tool_results + 最近 10 条消息
- 使用 EXTRACT_PROMPT 模板调用 LLM
- 输出：`SkillDraft` 数据类（name、description、trigger_keywords、steps、tools_used、parameters、preconditions、expected_outcome）
- 解析失败时记录日志并终止

### 4. VALIDATE 阶段 — 技能验证

- 完整性检查：所有必填字段非空
- 去重检查：embedding 搜索已有技能库，相似度 > 0.85 则跳过
- 安全检查：技能步骤不包含危险操作（删除数据、系统命令等）
- 质量评分：LLM 评估通用性和可复用性（0-1 分）
- 准入门槛：`quality_score >= min_quality_score`（默认 0.6）

### 5. REGISTER 阶段 — 技能注册

- 写入 `evolved_skills` 表
- 状态判定：`quality_score >= 0.8` 且 `auto_approve = true` → `auto_approved`，否则 → `pending_review`
- 记录来源信息：`agent_id`、`session_id`、`org_id`

### 6. INDEX 阶段 — 向量索引

- 生成技能描述的 embedding 向量
- 写入 pgvector
- 更新 SkillRegistry 缓存

### 7. SkillDraft 数据类

```python
@dataclass
class SkillDraft:
    name: str
    description: str
    trigger_keywords: list[str]
    steps: list[dict]
    tools_used: list[str]
    parameters: dict
    preconditions: dict
    expected_outcome: str
    quality_score: float = 0.0
    reusability_score: float = 0.0
```

### 8. EXTRACT_PROMPT 模板

- 包含 reflection、plan、tool_results、messages 占位符
- 输出 JSON 格式的技能定义
- 强调只提取通用复用价值的技能、参数化可变部分、步骤描述清晰

## Files to Create

- `runtime/src/evolution/__init__.py`
- `runtime/src/evolution/engine.py` — EvolutionEngine 核心类
- `runtime/src/evolution/prompts.py` — EXTRACT_PROMPT 等提示词模板
- `runtime/src/evolution/models.py` — SkillDraft 数据类
- `runtime/src/evolution/validators.py` — 安全检查、完整性检查

## Files to Modify

- `runtime/src/agent/nodes/reflect_node.py` — 在 REFLECT 完成后调用 `EvolutionEngine.maybe_evolve()`
- `runtime/src/agent/state.py` — AgentState 类型扩展（如需）

## Testing Requirements

### Unit Tests

- SkillDraft 数据类创建和序列化
- `_should_evolve` 各条件分支测试（成功/失败/边界）
- `_extract` LLM 调用 mock 测试
- `_validate` 去重/安全/质量评分测试
- `_register` 状态判定逻辑测试
- `_index` 向量生成和写入测试
- 异常处理和日志记录测试

### Integration Tests

- 完整 EXTRACT → VALIDATE → REGISTER → INDEX 流水线测试
- reflect_node 触发进化的集成测试

## Acceptance Criteria

- [ ] EvolutionEngine 通过构造函数注入依赖，不使用全局状态
- [ ] `maybe_evolve` 使用 `asyncio.create_task` 实现 fire-and-forget
- [ ] 所有触发条件正确实现，边界检查有日志
- [ ] EXTRACT_PROMPT 模板输出可被正确解析为 SkillDraft
- [ ] 去重检查使用 embedding 相似度 > 0.85 阈值
- [ ] 安全检查覆盖危险操作白名单
- [ ] 每个阶段独立写入 evolution_logs
- [ ] 异常不会传播到主流程（RESPOND 正常返回）
