# Semibot: SSE Connection Limits

**Priority:** Medium
**Status:** Not Started
**Type:** Enhancement
**Created:** 2026-02-05
**Last Updated:** 2026-02-05

## Overview

使用 `MAX_SSE_CONNECTIONS_PER_USER` 强制限制并发 SSE 连接数，避免资源耗尽。

## Features / Requirements

- 新连接时校验并发数
- 超限返回明确错误码
- 正常断开及时释放

## Files to Modify

- `apps/api/src/services/chat.service.ts`
- `apps/api/src/constants/errorCodes.ts` (如需新增错误码)

## Acceptance Criteria

- 超限时拒绝连接并返回错误码
- 连接释放后可继续建立
