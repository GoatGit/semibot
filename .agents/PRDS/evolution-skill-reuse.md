# Semibot: 进化系统 — 技能复用

**Priority:** High
**Status:** Not Started
**Type:** Feature
**Created:** 2026-02-17
**Last Updated:** 2026-02-17

## Overview

实现进化技能在 PLAN 阶段的智能检索与复用，包括 embedding 相似度搜索、LLM 技能匹配判断、plan_node 集成、使用计数与成功率追踪。

## Description

当新任务进入 PLAN 阶段时，系统会自动检索已审核通过的进化技能，通过 embedding 相似度搜索找到 top-5 相关技能，再由 LLM 判断是否可以复用。复用后自动更新使用计数和成功率，形成正向反馈循环。

参考设计文档：`docs/design/EVOLUTION.md` 第 3.2 节和第 5.3 节。

## Features / Requirements

### 1. 进化技能检索

- 将用户输入编码为 embedding 向量
- 在 `evolved_skills` 表中执行 pgvector 余弦相似度搜索
- 过滤条件：`status IN ('approved', 'auto_approved')` + `org_id` 租户隔离
- 返回 top-5 相关技能，包含相似度分数
- 相似度阈值：`>= 0.6` 才返回（避免噪声）

### 2. LLM 技能匹配判断

- 将检索到的进化技能格式化为 prompt 上下文
- LLM 评估每个候选技能是否适用于当前任务
- 输出：是否复用、复用哪个技能、需要调整的参数
- 如果无合适技能，正常走原有规划流程

### 3. plan_node_with_evolution 集成

```
用户输入 → embedding 编码 → 检索 top-5 进化技能 → LLM 判断复用 → 生成计划
```

- 修改现有 `plan_node`，在规划前增加进化技能检索步骤
- 将进化技能作为 `available_evolved_skills` 上下文注入 LLM
- 计划中可引用进化技能（`evolved_skill_refs`）
- 如果引用了进化技能，按技能定义的步骤执行

### 4. 使用计数与成功率追踪

- 复用时：`use_count += 1`，记录 `last_used_at`
- 复用成功时：`success_count += 1`
- 成功率计算：`success_rate = success_count / use_count`
- 在 OBSERVE/REFLECT 阶段判断复用是否成功，回写统计

### 5. 技能上下文格式化

将进化技能格式化为 LLM 可理解的 prompt 片段：

```text
## 可复用的进化技能

### 技能 1: {name} (相似度: {score})
描述: {description}
触发关键词: {trigger_keywords}
步骤: {steps}
使用次数: {use_count}, 成功率: {success_rate}
```

## Files to Create

- `runtime/src/evolution/retriever.py` — 进化技能检索器
- `runtime/src/evolution/formatter.py` — 技能上下文格式化

## Files to Modify

- `runtime/src/agent/nodes/plan_node.py` — 集成进化技能检索
- `runtime/src/agent/nodes/observe_node.py` — 复用成功判断和计数回写
- `apps/api/src/repositories/evolved-skill.repository.ts` — 新增 `incrementUseCount`、`incrementSuccessCount` 方法

## Testing Requirements

### Unit Tests

- embedding 检索返回正确的 top-5 结果
- 相似度阈值过滤测试
- 技能格式化输出测试
- 使用计数原子更新测试
- 成功率计算测试

### Integration Tests

- 完整复用流程：plan_node 检索 → LLM 判断 → 执行 → 计数更新
- 无匹配技能时正常走原有规划流程
- 租户隔离：不同 org_id 的技能不可互相检索

## Acceptance Criteria

- [ ] PLAN 阶段能检索到已审核通过的进化技能
- [ ] 检索结果按相似度排序，返回 top-5
- [ ] LLM 能正确判断是否复用进化技能
- [ ] 复用后 `use_count` 和 `success_count` 正确更新
- [ ] 无匹配技能时不影响原有规划流程
- [ ] 所有检索包含 `org_id` 租户隔离
- [ ] 只检索 `approved` 或 `auto_approved` 状态的技能
