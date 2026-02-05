# Semibot: M2 Core CRUD & Persistence

**Priority:** High
**Status:** Not Started
**Type:** Feature
**Created:** 2026-02-05
**Last Updated:** 2026-02-05

## Overview

将 Agents/Sessions/Messages 从内存 Map 迁移到数据库持久化，补齐状态流转与边界处理，实现多租户一致性。

## User Story

**As a** 开发者/管理员
**I want** 持久化管理 Agent 与会话
**So that** 数据可追踪、可查询、可复用

## Description

依据数据模型与 API 设计落地 CRUD，替换当前服务层 Map，实现分页、状态流转限制与软删除策略。

## Context

当前实现为内存 Map，重启即失效且无法多实例一致。

## Implementation Overview

- 使用数据库表：agents/sessions/messages
- 重写 service 层使用 DB
- 统一分页与排序
- 加强边界处理：完成/失败会话不允许继续写入

## Features / Requirements

1. **Agents CRUD**
- POST/GET/PUT/DELETE
- 支持分页、搜索、状态过滤

2. **Sessions CRUD**
- 创建会话、更新状态、删除
- 列表分页、状态过滤

3. **Messages**
- 列表与追加
- 超限处理与错误码

## Files to Create

- `apps/api/src/repositories/agent.repository.ts`
- `apps/api/src/repositories/session.repository.ts`
- `apps/api/src/repositories/message.repository.ts`

## Files to Modify

- `apps/api/src/services/agent.service.ts`
- `apps/api/src/services/session.service.ts`
- `apps/api/src/routes/v1/agents.ts`
- `apps/api/src/routes/v1/sessions.ts`

## Testing Requirements

### Unit Tests
- 状态流转与边界条件

### Integration Tests
- CRUD 流程
- 分页/过滤

## Acceptance Criteria

- Agents/Sessions/Messages 持久化可用
- 多租户隔离正确
- 边界处理符合设计
