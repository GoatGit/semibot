# 前端重构设计（Web UI）

> 版本：2.0 | 日期：2026-02-26 | 状态：设计完成（待持续实现）

## 1. 目标与边界

本设计用于 `Semibot V2` 的前端重构，遵循“重构而非重写”原则：

- 保留现有 `Next.js + React + Tailwind` 技术栈
- 与 V2 单机模式一致：默认无注册/登录、无多租户、无组织切换
- 前端定位为可选管理与协作界面，`CLI` 仍是主入口
- 前端只做展示与操作编排，不承载核心执行逻辑（执行在 runtime）

## 2. 设计目标（对应四大特性）

1. 快速执行：聊天与单次任务入口最短路径，低阻塞反馈（SSE 流式 + 执行过程可见）
2. 主动工作：事件、规则、审批可视化，支持“提醒/建议/自动执行”策略管理
3. 互相协作：围绕群聊协作场景展示任务分工、讨论、审批和结果回传
4. 持续进化：技能、工具、MCP 与运行结果打通，支持“可观测-可复盘-可优化”

## 3. 保留与改造

| 类型 | 方案 |
|------|------|
| 保留 | `App Router`、三栏布局骨架、Chat 页面、配置页、Agents/Skills/MCP 页面、现有 UI 组件库 |
| 保留 | `useChat` + SSE 流式机制、`sessionStore/layoutStore` 状态组织方式 |
| 改造 | 鉴权体系：前端固定单用户免登录模式，移除登录/注册/找回密码页面与交互流程 |
| 改造 | 配置中心：以“运行时配置”为准，前端配置与 runtime 配置双向同步 |
| 改造 | 导航信息架构：从“账号中心导向”改为“任务与事件导向” |
| 新增 | 事件中心、规则管理、审批中心、实时态势面板（面向 Event Engine） |

## 4. 信息架构（IA）

建议导航分组：

- 工作台：`/dashboard`
- 对话执行：`/chat`、`/chat/[sessionId]`
- 事件体系：`/events`、`/rules`、`/approvals`
- 能力体系：`/agents`、`/skills`、`/mcp`、`/tools`
- 配置中心：`/config`
- 系统与观测：`/runtime`（可并入 dashboard 二期）

建议路由结构：

```text
app/
  (dashboard)/
    dashboard/page.tsx
    chat/page.tsx
    chat/[sessionId]/page.tsx
    events/page.tsx
    rules/page.tsx
    approvals/page.tsx
    agents/page.tsx
    skills/page.tsx
    mcp/page.tsx
    tools/page.tsx
    config/page.tsx
```

## 5. 页面设计要点

## 5.1 Dashboard（总览页）

- 目标：5 秒内回答“系统是否可用、最近在干什么、我下一步做什么”
- 模块：
  - 运行状态卡片（LLM、Tools、MCP、会话活跃度）
  - 最近事件流（失败、审批、重要任务完成）
  - 待处理审批与风险提醒
  - 快捷动作（新建会话、运行任务、查看规则）

## 5.2 Chat（执行页）

- 目标：成为日常“下达任务 + 查看执行”的主界面
- 关键交互：
  - 输入区支持文本与附件
  - SSE 增量输出，过程卡片展示 `thinking/plan/tool_call/tool_result`
  - 一键“停止生成/重试”
  - 输出产物统一文件卡片下载
  - 新建会话入口统一到同一个动作（`create_session`），避免出现两套创建逻辑
- 体验约束：
  - 首包时间可见（加载骨架 + 状态提示）
  - 错误明确可恢复（重试、切模型、查看日志）

新建会话按钮规范：

- 可以有多个入口位置（导航栏、空状态页、欢迎区）
- 但必须共用同一个处理函数与跳转目标（统一到 `/chat/new`）
- 全局仅保留一个主 CTA 文案（推荐：`新建会话`），其他入口使用次级样式

## 5.3 Events（事件中心，新增）

- 数据：`GET /v1/events`、`POST /v1/events/replay`
- 核心能力：
  - 事件检索与筛选（类型、来源、风险、时间）
  - 事件详情（payload、匹配规则、执行动作）
  - 回放（replay）与回放结果追踪

## 5.4 Rules（规则管理，新增）

- 数据：`GET /v1/rules`、`POST /v1/rules`
- 核心能力：
  - 规则列表（启停、优先级、风险级别）
  - 规则编辑（条件、动作、去重/冷却/预算）
  - 规则仿真（可在二期接入）

## 5.5 Approvals（审批中心，新增）

- 数据：`POST /v1/approvals/{id}/approve|reject`
- 核心能力：
  - 待审批列表、审批详情
  - 一键批准/拒绝并记录理由
  - 与群聊卡片动作状态对齐（飞书场景）

## 5.6 Config（配置中心）

- 统一管理：
  - LLM Provider 配置与默认模型路由
  - Tools、API Keys、Webhook
  - Gateway（飞书、Telegram）
  - Runtime 注册能力（tools/skills）可见性
- 关键约束：
  - Tools 页面只展示“统一工具列表”，不区分“Runtime 内置工具/其他工具”两个分区
  - 前端配置修改必须写入 runtime 生效源
  - Tools / MCP 配置持久化到 `~/.semibot/semibot.db`（runtime SQLite），不走 Postgres
  - Gateway 配置也持久化到 `~/.semibot/semibot.db`
  - 配置变更后应有“已同步到 runtime”反馈
  - 不再展示组织配置（V2 单用户模式）
  - Tools 固定为内建能力：前端不提供新增/删除入口，只允许配置与启停（如权限、限流、超时、必要时的 endpoint/key）
  - `code_executor`、`file_io`、`browser_automation` 不展示 endpoint/key 配置项
  - `xlsx` / `pdf` 归类为 Skills，不在 Tools 配置页展示为可配置 Tool
  - Tools 风控配置以风险等级与 HITL 审批为主；`browser_automation` 额外支持 `allowLocalhost`、域名白/黑名单、`headless`、`browserType`
  - Gateway Tab 统一管理飞书与 Telegram，不把聊天网关混在 Webhook Tab

## 5.7 Gateway（新增）

- 数据（实例级）：`GET/POST /v1/config/gateway-instances`、`GET/PUT/DELETE /v1/config/gateway-instances/{instance_id}`、`POST /v1/config/gateway-instances/{instance_id}/test`
- provider：`feishu`、`telegram`（同 provider 可多实例）
- 核心能力：
  - 启停网关实例与查看配置状态（ready/not_configured/disabled）
  - 新建/删除实例，支持设置 default instance（用于兼容 provider 旧接口）
  - 编辑飞书参数（verify token、webhook 等）
  - 编辑 Telegram 参数（agent 绑定、bot token、chat id 白名单等）
  - 编辑通用策略参数：
    - `addressingPolicy`（`mode`、`allowReplyToBot`、`executeOnUnaddressed`、`commandPrefixes`、`sessionContinuationWindowSec`）
    - `proactivePolicy`（`mode`、`minRiskToNotify`）
    - `contextPolicy`（`ttlDays`、`maxRecentMessages`、`summarizeEveryNMessages`）
  - 发送测试消息并展示最近连通性结果

## 6. 前端状态与数据流

## 6.1 状态分层

- 页面临时态：组件内 `useState`
- 会话执行态：`sessionStore`
- 布局态：`layoutStore`
- 运行模式态：单用户上下文（仅保留兼容字段，不承载登录态）

## 6.2 API 与流式策略

- 普通请求：`apiClient`（统一超时、重试、错误包装）
- 流式对话：`fetch + text/event-stream`（绕过会缓冲 SSE 的代理路径）
- `/chat` 页面调用统一聊天接口（`/v1/chat` 或 `/v1/chat/sessions/*`），不直接连接 runtime 内部执行协议
- 错误处理：
  - 401 仅作为普通请求错误处理，不触发登录跳转
  - 统一错误 toast + 页面内可恢复提示

## 6.3 单用户无鉴权模式（固定）

- 默认：`AUTH_DISABLED = true`，并固定为前端默认语义
- 行为：
  - 中间件不拦截业务路由到登录页
  - `/login`、`/register`、`/forgot-password` 统一重定向到 `/dashboard`
  - API 请求不强制附带 token
  - 左侧导航不再展示用户头像/退出入口

## 7. 组件与代码组织建议

```text
apps/web/
  app/(dashboard)/*            # 页面路由
  components/
    layout/*                   # 外壳、导航、详情面板
    domain/
      chat/*                   # 聊天域组件
      events/*                 # 事件域组件
      rules/*                  # 规则域组件
      approvals/*              # 审批域组件
      config/*                 # 配置域组件
    ui/*                       # 基础组件
  hooks/*                      # useChat/useSSE/useXxx
  stores/*                     # Zustand 状态
  lib/*                        # api client、mode 判断、工具函数
```

落地原则：

- 新增能力优先做“domain 组件”，不要把业务逻辑堆在 page.tsx
- 页面只负责拼装，领域逻辑下沉到 hooks + domain 组件
- API 类型定义收敛到统一 `types`，避免页面自行定义重复接口

## 8. 与后端契约映射

前端一阶段必须覆盖以下接口：

- 对话执行：`POST /v1/chat`、`GET/DELETE /v1/sessions`
- 任务执行：`POST /v1/tasks/run`
- 事件体系：`GET /v1/events`、`POST /v1/events/replay`
- 规则体系：`GET /v1/rules`、`POST /v1/rules`
- 审批体系：`POST /v1/approvals/{id}/approve|reject`
- 配置与能力：`/v1/llm-providers/*`、`/v1/tools`、`/v1/runtime/skills`

> 以上接口以 `api-contracts.md` 为单一事实来源，前端页面仅做契约消费。

## 9. E2E 验收清单（前端）

1. 启动后默认进入 dashboard/chat，不触发登录跳转，访问 `/login` 自动回到 `/dashboard`
2. 聊天流式输出正常，支持停止/重试，刷新后历史可回显
3. 配置中心可读可写，LLM 配置变更后运行时可生效
4. Tools/Skills 数据可见，空态与异常态可读
5. 事件列表可筛选，可回放，回放结果可追踪
6. 审批操作可执行，状态实时更新

## 10. 里程碑（前端）

- M1（已完成基线）：无鉴权化、Chat 与 Config 可用、导航统一
- M2：Events/Rules/Approvals 三页上线，打通 Event Engine 最小闭环
- M3：Dashboard 实时态势 + 协作视图（飞书回传态）+ 回放可视化
- M4：体验强化（规则仿真、批量操作、深度观测）

## 11. 非目标（本轮不做）

- 多组织/多用户权限模型
- 前端自建复杂编排逻辑（保持“后端编排、前端可视化”）
- TUI 主线投入
- 脱离现有 Next.js 体系的前端重写

## 12. 澄清记录（持续补充）

Q1：`/chat` 是否直连 runtime，不再需要连接执行层面？  
A：前端不直接连接 runtime 执行层协议。前端只调用统一 HTTP/SSE 接口；执行层连接、会话上下文与编排由后端处理。

Q2：新建会话按钮和会话页按钮是否应该合并？  
A：应该合并“动作”，不必强制合并“入口位置”。可以在多个位置展示按钮，但都必须复用同一创建逻辑与同一路由目标，避免行为不一致。
