# Semibot: M6 Frontend Real Integration

**Priority:** Medium
**Status:** Not Started
**Type:** Feature
**Created:** 2026-02-05
**Last Updated:** 2026-02-05

## Overview

替换前端 mock 数据，接入真实 API 与 SSE，启用 Agent2UI 渲染与 DetailCanvas 动态内容。

## Features / Requirements

1. **Agents/Skills/MCP 页面真实化**
- CRUD 接入 API

2. **Chat 与 SSE**
- 使用 useChat + SSE 实时渲染

3. **Agent2UI 渲染**
- 列表与详情渲染统一

## Files to Modify

- `apps/web/app/(dashboard)/agents/page.tsx`
- `apps/web/app/(dashboard)/skills/page.tsx`
- `apps/web/app/(dashboard)/mcp/page.tsx`
- `apps/web/app/(dashboard)/chat/*`

## Acceptance Criteria

- UI 数据来自 API
- SSE 能实时渲染
- DetailCanvas 按消息动态变化
