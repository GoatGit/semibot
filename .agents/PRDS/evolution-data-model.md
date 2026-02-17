# Semibot: 进化系统 — 数据模型层

**Priority:** High
**Status:** Not Started
**Type:** Feature
**Created:** 2026-02-17
**Last Updated:** 2026-02-17

## Overview

实现进化系统的数据库层，包括 `evolved_skills` 表、`evolution_logs` 表、`agents.config` 进化配置扩展，以及对应的迁移文件。

## Description

进化系统需要持久化两类核心数据：进化产生的技能（evolved_skills）和进化过程日志（evolution_logs）。同时需要在 Agent 配置中扩展进化相关的开关和参数。数据模型需支持 pgvector 向量索引用于技能相似度检索，以及乐观锁、软删除、审计字段等项目标准规范。

参考设计文档：`docs/design/EVOLUTION.md` 第 4 节（数据模型）。

## Features / Requirements

### 1. evolved_skills 表

- 存储进化产生的技能定义（name、description、steps、tools_used、parameters 等）
- 支持 pgvector 向量索引（embedding VECTOR(1536)），用于技能相似度检索
- 状态流转：`pending_review` → `approved` / `rejected` / `auto_approved` → `deprecated`
- 使用统计字段：`use_count`、`success_count`、`last_used_at`
- 审核字段：`reviewed_by`、`reviewed_at`、`review_comment`
- 租户隔离：`org_id` 必填，所有查询必须带 `org_id` 过滤

### 2. evolution_logs 表

- 记录进化流程每个阶段（EXTRACT / VALIDATE / REGISTER / INDEX）的执行状态
- 阶段状态：`started` / `completed` / `failed` / `skipped`
- 记录输入输出数据（JSONB）、错误信息、耗时、Token 消耗
- 关联 `evolved_skill_id`（如有产出）

### 3. agents.config 进化配置扩展

- 在 `agents.config` JSONB 字段中新增 `evolution` 配置块
- 字段：`enabled`、`auto_approve`、`min_quality_score`、`max_evolve_per_hour`、`cooldown_minutes`
- 默认值：`enabled=false`、`auto_approve=false`、`min_quality_score=0.6`、`max_evolve_per_hour=5`、`cooldown_minutes=10`

### 4. Repository 层

- `EvolvedSkillRepository` 实现标准 Repository 接口（findById、findByIdAndOrg、findByOrg、create、update、softDelete、countByOrg、findByIds）
- 新增方法：`findByEmbedding`（向量相似度检索）、`findByStatus`、`updateUseCount`、`updateReviewStatus`
- `EvolutionLogRepository` 实现日志写入和查询

### 5. shared-types 类型定义

- `EvolvedSkill` Entity 类型
- `EvolutionLog` Entity 类型
- `EvolutionConfig` 配置类型
- `CreateEvolvedSkillInput`、`UpdateEvolvedSkillInput`、`EvolvedSkillResponse` DTO 类型

## Files to Create

- `docs/sql/014_evolved_skills.sql` — evolved_skills 表 DDL + 索引
- `docs/sql/015_evolution_logs.sql` — evolution_logs 表 DDL + 索引
- `apps/api/src/repositories/evolved-skill.repository.ts` — 进化技能 Repository
- `apps/api/src/repositories/evolution-log.repository.ts` — 进化日志 Repository
- `packages/shared-types/src/evolution.ts` — 进化相关类型定义

## Files to Modify

- `packages/shared-types/src/index.ts` — 导出进化类型
- `packages/shared-types/src/dto.ts` — 新增进化相关 DTO

## Testing Requirements

### Unit Tests

- EvolvedSkillRepository CRUD 操作测试
- EvolutionLogRepository 写入和查询测试
- 向量相似度检索测试（mock pgvector）
- 乐观锁冲突测试
- 软删除测试

### Integration Tests

- 完整的数据库迁移执行测试（幂等性验证）
- 跨表关联查询测试
- 租户隔离验证（不同 org_id 数据不可互访）

## Acceptance Criteria

- [ ] 迁移脚本可幂等执行（`IF NOT EXISTS`）
- [ ] evolved_skills 表支持 pgvector 向量检索
- [ ] 所有 Repository 方法包含 `org_id` 租户隔离
- [ ] JSONB 字段使用 `sql.json()` 写入，禁止 `JSON.stringify()`
- [ ] shared-types 中类型定义完整，字段使用 camelCase
- [ ] 乐观锁机制正常工作（version 字段）
- [ ] 软删除机制正常工作（deleted_at 字段）
