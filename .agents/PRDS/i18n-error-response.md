# Semibot: I18N Error Response

**Priority:** Low
**Status:** Not Started
**Type:** Enhancement
**Created:** 2026-02-05
**Last Updated:** 2026-02-05

## Overview

实现基于 `Accept-Language` 的错误消息国际化（至少 zh-CN / en-US）。

## Features / Requirements

- 统一错误响应格式
- 支持语言回退策略

## Files to Modify

- `apps/api/src/middleware/errorHandler.ts`
- `apps/api/src/constants/errorCodes.ts`
- `apps/api/src/middleware/auth.ts`

## Acceptance Criteria

- 按请求头返回对应语言
- 默认 zh-CN
