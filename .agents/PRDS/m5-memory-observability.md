# Semibot: M5 Memory & Observability

**Priority:** Medium
**Status:** Not Started
**Type:** Feature
**Created:** 2026-02-05
**Last Updated:** 2026-02-05

## Overview

接入短期记忆 Redis 与长期记忆 pgvector，并落地 execution_logs/usage_logs 计量与可观测闭环。

## Features / Requirements

1. **短期记忆**
- 会话上下文 Redis 存取

2. **长期记忆**
- pgvector 语义检索

3. **计量与日志**
- execution_logs/usage_logs 落库
- 查询 API

## Files to Create

- `apps/api/src/routes/v1/memory.ts`
- `apps/api/src/routes/v1/logs.ts`
- `apps/api/src/services/memory.service.ts`
- `apps/api/src/services/logs.service.ts`

## Acceptance Criteria

- 记忆可存取
- 日志可查询
- 用量可统计
