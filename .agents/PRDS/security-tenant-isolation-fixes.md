# Semibot: Security & Tenant Isolation Fixes

**Priority:** High
**Status:** Not Started
**Type:** Bug
**Created:** 2026-02-05
**Last Updated:** 2026-02-05

## Overview

修复两处安全与租户隔离漏洞：公开 Agent 访问控制与 Memory 相似搜索未按 org 过滤。

## Description

- `getAgentPublic` 当前逻辑允许非公开但活跃的 agent 被访问
- `searchSimilarMemories` 未按 org_id 过滤，存在跨租户风险

## Features / Requirements

1. **公开 Agent 校验修复**
- 非公开或非活跃均应拒绝访问

2. **记忆搜索租户隔离**
- searchSimilar 必须按 org_id 过滤
- 相关索引与查询需兼容

## Files to Modify

- `apps/api/src/services/agent.service.ts`
- `apps/api/src/services/memory.service.ts`
- `apps/api/src/repositories/memory.repository.ts`

## Testing Requirements

### Unit Tests
- public agent 访问规则
- memory search org 过滤

## Acceptance Criteria

- 非公开/非活跃 agent 不可访问
- memory search 不可跨租户返回
