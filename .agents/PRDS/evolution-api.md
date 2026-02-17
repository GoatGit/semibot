# Semibot: 进化系统 — API 端点

**Priority:** Medium
**Status:** Not Started
**Type:** Feature
**Created:** 2026-02-17
**Last Updated:** 2026-02-17

## Overview

实现进化系统的 API 端点，包括进化技能的列表/详情/审核/删除/提升、进化统计、进化配置更新，共 7 个端点。

## Description

为前端管理界面和外部集成提供进化技能的完整 CRUD 和审核工作流 API。所有端点遵循项目 API 规范：Zod Schema 验证、camelCase 字段命名、统一响应格式、租户隔离。

参考设计文档：`docs/design/EVOLUTION.md` 第 6 节（API 设计）。

## Features / Requirements

### 1. 列出进化技能

```http
GET /api/v1/evolved-skills?status=pending_review&agentId=xxx&limit=20&cursor=xxx
```

- Query 参数：`status`（按状态过滤）、`agentId`（按 Agent 过滤）、`limit`（分页大小，默认 20）、`cursor`（分页游标）
- 响应：分页列表 + CursorPaginationMeta
- 排序：按 `created_at DESC`

### 2. 获取进化技能详情

```http
GET /api/v1/evolved-skills/:id
```

- 返回完整技能定义、质量评分、使用统计、审核信息
- 包含来源 Agent 和 Session 信息

### 3. 审核进化技能

```http
POST /api/v1/evolved-skills/:id/review
```

```json
{
    "action": "approve",
    "comment": "审核意见"
}
```

- `action`：`approve` 或 `reject`（必填）
- `comment`：审核意见（选填）
- 更新 `status`、`reviewed_by`、`reviewed_at`、`review_comment`
- 只有 `pending_review` 状态的技能可被审核

### 4. 删除/废弃进化技能

```http
DELETE /api/v1/evolved-skills/:id
```

- 软删除：将 `status` 设为 `deprecated`
- 记录操作人和时间

### 5. 提升为正式技能

```http
POST /api/v1/evolved-skills/:id/promote
```

- 将 `evolved_skill` 转换为 `skills` 表中的正式技能
- `source_type` 标记为 `'evolved'`
- 只有 `approved` 或 `auto_approved` 状态的技能可被提升

### 6. 获取进化统计

```http
GET /api/v1/agents/:agentId/evolution/stats
```

- 返回：`totalEvolved`、`approvedCount`、`rejectedCount`、`pendingCount`、`approvalRate`、`totalReuseCount`、`avgQualityScore`、`topSkills`

### 7. 更新 Agent 进化配置

```http
PUT /api/v1/agents/:agentId/evolution
```

```json
{
    "enabled": true,
    "autoApprove": false,
    "minQualityScore": 0.6,
    "maxEvolvePerHour": 5,
    "cooldownMinutes": 10
}
```

- 更新 `agents.config.evolution` JSONB 字段
- 使用 `sql.json()` 写入

## Files to Create

- `apps/api/src/routes/v1/evolved-skills.ts` — 路由定义 + Zod Schema 验证
- `apps/api/src/services/evolved-skill.service.ts` — 业务逻辑层
- `apps/api/src/repositories/evolved-skill.repository.ts` — 数据访问层（如未在 data-model PRD 中���建）

## Files to Modify

- `apps/api/src/routes/v1/index.ts` — 注册进化技能路由
- `apps/api/src/routes/v1/agents.ts` — 新增进化统计和配置端点
- `packages/shared-types/src/dto.ts` — 新增进化相关 DTO 类型

## Testing Requirements

### Unit Tests

- 每个端点的 Zod Schema 验证测试（合法/非法输入）
- Service 层业务逻辑测试（mock Repository）
- 审核状态流转测试（只有 pending_review 可审核）
- 提升逻辑测试（只有 approved/auto_approved 可提升）

### Integration Tests

- 完整 CRUD 流程测试
- 审核工作流端到端测试
- 分页和过滤测试
- 租户隔离测试（不同 org_id 不可互访）

## Acceptance Criteria

- [ ] 7 个 API 端点全部实现并可用
- [ ] 所有端点使用 Zod Schema 验证输入
- [ ] 响应格式符合 `ApiResponse<T>` 标准
- [ ] 字段命名统一使用 camelCase
- [ ] 所有查询包含 `org_id` 租户隔离
- [ ] 审核和提升操作有状态前置检查
- [ ] 错误响应包含明确的错误码和提示信息
