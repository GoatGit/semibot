# PRD: Chat 主流程切换到 Runtime Orchestrator

## 概述

| 字段 | 值 |
|------|-----|
| **功能名称** | Chat 切到 Runtime |
| **版本** | 1.0 |
| **优先级** | P0 |
| **关联任务** | [TASK](../TASKS/chat-cutover-to-runtime.md) |
| **创建时间** | 2026-02-08 |

## 背景

当前 API `chat.service` 仍主要走“直接 LLM 流式回复”模式，未完整进入 runtime state machine。导致：
- skill/tool/mcp 调用链不统一；
- 事件协议与审计字段不完整；
- 与 runtime 既有能力重复且行为分叉。

## 目标

1. 将 Chat 请求统一路由到 runtime orchestrator；
2. 保持现有 SSE 对前端兼容，并补齐结构化事件；
3. 实现灰度切换与可回滚；
4. 在不破坏现网的前提下完成迁移。

## 现状（As-Is）

- API 侧直接调用 `llmService.generateStream`；
- 仅做有限 `tool_call` 事件透传；
- 无 runtime 计划执行与统一 action 审计。

## 目标架构（To-Be）

### 1. Chat Gateway 层

- API 入口保持不变：`POST /chat` + SSE；
- 新增 `ChatExecutionMode`：
  - `direct_llm`（旧）
  - `runtime_orchestrator`（新）
- 默认灰度开关控制切换比例或按 org 白名单切换。

### 2. Runtime Adapter 层

- API 将消息、会话、agent、上下文转换为 runtime 输入 state；
- runtime 输出事件映射为 Agent2UI SSE 事件；
- 统一错误映射（runtime error -> API error code）。

### 3. SSE 协议

- 保留兼容事件：`message`、`error`、`done`；
- 新增结构化 payload：
  - `plan_step`
  - `skill_call/skill_result`
  - `tool_call/tool_result`
  - `mcp_call/mcp_result`
  - `progress`

### 4. 审计与回放

- 每次会话保存 runtime execution trace；
- 支持按 session 重建关键执行链；
- 错误附带 `step_id/call_id`。

## 迁移策略

### Phase 1: 双写对比（影子模式）

- API 仍返回 direct_llm 结果；
- 后台异步跑 runtime 结果对比（不对用户返回）；
- 收集一致性指标（响应内容、调用次数、时延）。

### Phase 2: 灰度切换

- 按 org 白名单切 runtime；
- 监控错误率、超时率、回退率；
- 超阈值自动回退 direct_llm。

### Phase 3: 全量切换

- 默认 runtime；
- direct_llm 保留为应急 fallback。

## 配置需求

- `CHAT_EXECUTION_MODE`：默认模式；
- `CHAT_RUNTIME_ENABLED_ORGS`：灰度白名单；
- `CHAT_RUNTIME_SHADOW_PERCENT`：影子流量比例；
- `CHAT_RUNTIME_TIMEOUT_MS`：runtime 超时。

## 验收标准

- chat 主流程可在 runtime 模式稳定运行；
- SSE 事件兼容旧前端且支持新事件；
- 灰度期具备自动回退机制；
- 全链路可观测（trace + metrics + logs）。
