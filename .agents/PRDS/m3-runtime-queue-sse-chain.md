# Semibot: M3 Runtime + Queue + SSE Chain

**Priority:** High
**Status:** Not Started
**Type:** Feature
**Created:** 2026-02-05
**Last Updated:** 2026-02-05

## Overview

建立从 API 到 Runtime 的异步执行链路，Redis 作为任务队列，Runtime 执行 LangGraph 并通过 SSE 回传 Agent2UI 消息。

## Description

替换当前 chat 模拟响应，接入队列与运行时，确保长任务可异步处理并实时推送。

## Implementation Overview

- API 写入 Redis Stream/Queue
- Runtime Worker 消费任务并执行 LangGraph
- SSE 通道回传 Agent2UI 事件
- done/error 事件闭环

## Features / Requirements

1. **队列生产与消费**
- API 投递任务
- Runtime 拉取并执行

2. **SSE 事件模型**
- message/done/error/heartbeat
- 与 Agent2UI 类型一致

## Files to Create

- `apps/api/src/services/queue.service.ts`
- `runtime/src/queue/consumer.py` (完善)
- `runtime/src/queue/producer.py` (完善)

## Files to Modify

- `apps/api/src/services/chat.service.ts`
- `apps/api/src/routes/v1/chat.ts`
- `runtime/src/orchestrator/*`

## Testing Requirements

### Integration Tests
- API -> Queue -> Runtime -> SSE 端到端

## Acceptance Criteria

- SSE 实时返回 Agent2UI 消息
- 任务队列正确消费与确认
- 错误可回传
