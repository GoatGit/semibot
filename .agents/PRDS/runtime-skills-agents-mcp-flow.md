# PRD: Runtime 中 Skills / Agents / MCP 统一执行流程

## 概述

| 字段 | 值 |
|------|-----|
| **功能名称** | Runtime 统一执行流程 |
| **版本** | 1.0 |
| **优先级** | P0 |
| **关联任务** | [TASK](../TASKS/runtime-skills-agents-mcp-flow.md) |
| **创建时间** | 2026-02-08 |

## 背景

当前 runtime 具备 `orchestrator + skill_registry + action_executor` 能力，但与 API 主流程存在割裂：
- skill registry 加载来源不统一；
- planner 可见工具集与 agent 绑定不一致；
- MCP 与 skills/tool 执行链缺少统一上下文与审计。

## 目标

1. 统一 runtime 执行图中的能力来源（skills/tools/mcp）；
2. 按 agent 绑定与会话上下文动态构建可执行能力集；
3. 实现统一执行事件与审计输出；
4. 明确错误分类与恢复策略。

## 流程规范（目标态）

### 1. Session Bootstrap

- 输入：`org_id, user_id, agent_id, session_id`。
- 加载：
  - agent 配置（模型、策略）；
  - agent 绑定 skills（可执行版本）；
  - 组织可用 MCP 连接与权限；
  - runtime policy（sandbox、rate-limit、safety）。

### 2. Capability Graph 构建

- 构建会话级能力图：
  - `Tools`（内置能力）
  - `Skills`（目录型包入口）
  - `MCP Tools/Resources`（远程能力）
- 统一输出给 planner 的 schema；
- planner 禁止看到未绑定能力。

### 3. Planning & Acting

- PLAN 仅基于会话能力图生成 steps；
- ACT 统一走 `ActionExecutor`：
  - tool 调用；
  - skill 调用；
  - mcp 调用；
  - 子 agent 委派（可选）。
- 所有调用必须带上下文（org/session/user/agent）。

### 4. Observability

- 标准事件：`plan_step`、`skill_call`、`tool_call`、`mcp_call`、`*_result`、`error`。
- 统一审计字段：
  - `call_type`、`target`、`version`、`status`、`latency_ms`、`error_code`。
- 统一 metrics：
  - 调用次数、失败率、p95 时延、超时率。

## 功能需求

### 1. Skill Registry 动态装载

- 从 DB + package store 装载 skill；
- 支持按 agent 绑定过滤；
- 支持版本锁定与 latest 策略；
- 支持热更新（可选）。

### 2. MCP 桥接规范

- MCP server 连接状态与工具清单同步到 runtime；
- 连接失败对 planner 可见性有降级策略；
- mcp 调用错误统一映射到平台错误码。

### 3. Agent 执行策略

- 支持 `max_iterations`、`replan`、`timeout` 等策略；
- 支持强制审批（高风险 skills/mcp）；
- 支持并行步骤但需可审计顺序。

### 4. 隔离策略（全租户共享技能前提）

- 可见性可共享，但执行上下文必须隔离；
- memory/cache/tmp 路径按 `org_id` 命名空间隔离；
- 禁止跨组织 session 引用。

## 相关模块

- `runtime/src/orchestrator/nodes.py`
- `runtime/src/orchestrator/executor.py`
- `runtime/src/skills/registry.py`
- `apps/api/src/services/chat.service.ts`
- `apps/api/src/services/agent.service.ts`

## 验收标准

- planner 输入能力集与 agent 绑定完全一致；
- runtime 可区分并执行 skill/tool/mcp 三类调用；
- 调用日志可按 org/session 回放；
- mcp 断连场景有明确降级行为；
- 集成测试覆盖成功链路与失败链路。
