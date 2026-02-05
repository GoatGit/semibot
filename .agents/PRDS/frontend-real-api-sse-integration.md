# Semibot: Frontend Real API & SSE Integration

**Priority:** Medium
**Status:** Not Started
**Type:** Feature
**Created:** 2026-02-05
**Last Updated:** 2026-02-05

## Overview

替换前端 mock 数据，接入真实 API 与 SSE，确保 Chat、Agents、Skills、MCP 页面完整可用。

## Features / Requirements

- Chat 页面使用 `useChat` + SSE
- Agents/Skills/MCP 列表与 CRUD 接入 API
- Agent2UI 渲染与 DetailCanvas 动态内容

## Files to Modify

- `apps/web/app/(dashboard)/chat/*`
- `apps/web/app/(dashboard)/agents/*`
- `apps/web/app/(dashboard)/skills/*`
- `apps/web/app/(dashboard)/mcp/*`

## Acceptance Criteria

- 所有页面不再使用 mock 数据
- SSE 流式消息正确渲染
