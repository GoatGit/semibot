# Semibot: Chat Runtime Queue Integration

**Priority:** High
**Status:** Not Started
**Type:** Feature
**Created:** 2026-02-05
**Last Updated:** 2026-02-05

## Overview

实现真实 Chat 执行链路：API 投递任务到队列，Runtime 消费并执行 LangGraph，SSE 回传 Agent2UI 事件。替换当前模拟计划/工具/响应逻辑。

## User Story

**As a** 平台用户
**I want** 与 Agent 的对话触发真实执行并流式返回结果
**So that** 能得到可追踪、可复现的执行过程与结果

## Description

当前 `chat.service.ts` 仍为模拟逻辑，`queue.service.ts` 为 stub，Runtime 使用 BRPOP 模式。此任务统一队列协议、落地 Redis 连接、并实现 SSE 事件闭环。

## Implementation Overview

- 统一队列协议（List 或 Stream 二选一，并在 API/Runtime 一致）
- API 侧投递任务并记录 request_id
- Runtime 消费任务并执行 LangGraph
- 执行过程与结果通过 SSE 事件回传

## Features / Requirements

1. **队列落地**
- 使用 Redis 真正写入/读取
- 统一队列协议（List 或 Stream）

2. **Runtime 执行**
- 接入 LangGraph 真实执行
- 生成 Agent2UI 事件

3. **SSE 事件闭环**
- message/done/error/heartbeat
- 结束事件带 messageId/sessionId

## Files to Create

- `apps/api/src/lib/redis.ts` (如需)

## Files to Modify

- `apps/api/src/services/chat.service.ts`
- `apps/api/src/services/queue.service.ts`
- `runtime/src/queue/consumer.py`
- `runtime/src/orchestrator/*`

## Testing Requirements

### Integration Tests
- API -> Queue -> Runtime -> SSE 端到端

## Acceptance Criteria

- chat 不再使用模拟逻辑
- 队列与 Runtime 协议一致
- SSE 可实时返回 Agent2UI 事件
