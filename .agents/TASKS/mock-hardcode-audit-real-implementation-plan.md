## Task: Mock/硬编码审查与真实实现替换方案

**ID:** mock-hardcode-audit-real-implementation-plan
**Label:** Semibot: Mock/硬编码替换为真实实现
**Description:** 审查生产代码中的 mock 数据与硬编码逻辑，给出可执行的真实实现替换方案与分期计划
**Type:** Tech Debt
**Status:** Done
**Priority:** P1 - High
**Created:** 2026-02-08
**Updated:** 2026-02-08
**PRD:** N/A

---

### 审查范围

- 仅审查运行时/业务代码（`apps/api`、`apps/web`、`runtime/src`）
- 不将测试目录中的 mock（`__tests__`、`runtime/tests`）计入整改项
- 不将文档示例、UI 占位文案（`placeholder=`）计入整改项

### 发现的问题（按优先级）

#### P0（必须优先处理）

1) **聊天服务在 LLM 不可用时走“模拟回复”并落库**
- 位置：`apps/api/src/services/chat.service.ts:243`
- 位置：`apps/api/src/services/chat.service.ts:340`
- 问题：当前会返回伪造内容并写入会话，污染真实业务数据与监控。
- 替换方案：
  - 移除 `handleMockResponse` 调用链，改为标准错误事件（SSE `error` + 明确错误码，如 `LLM_UNAVAILABLE`）。
  - 不写入模拟 assistant 消息；仅保留用户消息和失败事件日志。
  - 在前端统一展示“模型服务不可用”的可重试状态。

2) **Runtime 执行器存在 Placeholder 返回**
- 位置：`runtime/src/orchestrator/executor.py:285`
- 位置：`runtime/src/orchestrator/executor.py:290`
- 问题：`_execute_search` / `_execute_llm_call` 仍为占位逻辑，执行结果不可信。
- 替换方案：
  - `search` 接入统一搜索 provider（与现有工具注册/skill registry 对齐）。
  - `llm_call` 接入 runtime 的 LLM router/provider（超时、重试、错误映射）。
  - 增加契约测试：输入参数校验、错误码稳定性、超时行为。

#### P1（高优先级）

3) **Agent 详情页仍是本地 mock 状态页**
- 位置：`apps/web/app/(dashboard)/agents/[agentId]/page.tsx:59`
- 位置：`apps/web/app/(dashboard)/agents/[agentId]/page.tsx:78`
- 位置：`apps/web/app/(dashboard)/agents/[agentId]/page.tsx:262`
- 问题：页面使用本地对象、模拟保存延迟、硬编码模型选项，未走真实 API。
- 替换方案：
  - 读取：接入 `GET /agents/:id`。
  - 保存：接入 `PATCH /agents/:id` 与创建逻辑（`POST /agents`）。
  - 模型：复用已接好的 `/llm-providers/models` 动态列表，不保留本地 `<option>`。
  - 工具/统计 Tab：分别接入真实数据源或明确标注“未实现”并隐藏入口。

4) **Skills 页面使用 mockSkills 本地增删改**
- 位置：`apps/web/app/(dashboard)/skills/page.tsx:37`
- 位置：`apps/web/app/(dashboard)/skills/page.tsx:122`
- 问题：技能数据完全前端内存态，不持久化、不鉴权、不与后端一致。
- 替换方案：
  - 列表：`GET /skills`
  - 新增：`POST /skills`
  - 编辑：`PUT /skills/:id`
  - 删除：`DELETE /skills/:id`
  - 启用/禁用：走 `PUT /skills/:id` 的 `isActive` 字段

5) **MCP 页面使用 mockServers 本地状态切换**
- 位置：`apps/web/app/(dashboard)/mcp/page.tsx:37`
- 位置：`apps/web/app/(dashboard)/mcp/page.tsx:109`
- 位置：`apps/web/app/(dashboard)/mcp/page.tsx:154`
- 问题：连接状态与工具列表都为前端模拟，不反映真实 server 状态。
- 替换方案：
  - 列表：`GET /mcp`
  - 新增：`POST /mcp`
  - 编辑：`PUT /mcp/:id`
  - 删除：`DELETE /mcp/:id`
  - 测试连接：`POST /mcp/:id/test`
  - 同步工具/资源：`POST /mcp/:id/sync`

6) **设置页存在伪造用户资料和 API Key**
- 位置：`apps/web/app/(dashboard)/settings/page.tsx:112`
- 位置：`apps/web/app/(dashboard)/settings/page.tsx:150`
- 问题：`developer`、`dev@example.com`、`sk-prod-xxx` 为假数据，误导用户。
- 替换方案：
  - 个人资料：接入 `GET/PATCH /users/me`（若无则新增后端路由）。
  - API Key：接入现有 `/api-keys` 路由（列表/创建/删除），前端只显示一次明文。
  - 偏好设置：落到用户配置表（theme/language）并提供持久化接口。

7) **忘记密码仅前端调用，后端缺路由**
- 位置：`apps/web/app/(auth)/forgot-password/page.tsx:37`
- 问题：前端调用 `/auth/forgot-password`，但 API 侧未实现对应路由。
- 替换方案：
  - 新增后端接口：`POST /auth/forgot-password`、`POST /auth/reset-password`
  - 增加邮件发送抽象（SMTP/第三方）与限流、防枚举策略
  - 前端改为消费真实接口错误码并保留“安全成功提示”策略

#### P2（中优先级）

8) **LLM 模型显示名仍有硬编码映射**
- 位置：`apps/api/src/routes/v1/llm-providers.ts:19`
- 问题：模型展示名维护成本高，新增模型需改代码。
- 替换方案：
  - 优先使用 provider 返回元数据（`display_name`）；无则回退 `modelId`。
  - 为 `/llm-providers/models` 增加 `displayNameSource` 字段（provider|fallback）。

9) **Agent 默认模型硬编码**
- 位置：`apps/api/src/services/agent.service.ts:86`
- 问题：默认 `gpt-4o / gpt-4o-mini` 与实际可用 provider 可能不一致。
- 替换方案：
  - 启动时从 `llm providers` 可用模型中选默认（或读取租户级配置）。
  - 若无模型可用，创建 Agent 时显式报错，避免写入不可用配置。

### 实施阶段建议

#### 阶段 A（本周）
- [x] 移除聊天 mock 回复路径，改为统一失败事件
- [x] 完成 Skills/MCP 页面真实 API 接入
- [x] 完成 Agent 详情页真实读写与模型动态加载

#### 阶段 B（下周）
- [x] 完成 settings 真实化（profile + api keys + preferences）
- [x] 完成 forgot-password / reset-password 后端能力
- [x] 清理 LLM displayName 硬编码映射

#### 阶段 C（稳定性）
- [x] Runtime executor 的 search/llm_call Placeholder 替换为真实执行链
- [x] 增加集成测试覆盖（SSE 失败路径、skills/mcp CRUD、auth reset flow）
- [x] 增加可观测性（失败原因、fallback 率、无模型配置告警）

### 验收标准

- [x] 生产路径无 mock 响应落库
- [x] 前端关键管理页（Agents/Skills/MCP/Settings）不再使用本地 mock 数据源
- [x] `/auth/forgot-password` 与 `/auth/reset-password` 可用并有安全防护
- [x] Runtime 执行器不再返回 Placeholder 结果
- [x] 新增/调整逻辑具备对应 API/集成测试

### 相关文件

- `apps/api/src/services/chat.service.ts`
- `runtime/src/orchestrator/executor.py`
- `apps/web/app/(dashboard)/agents/[agentId]/page.tsx`
- `apps/web/app/(dashboard)/skills/page.tsx`
- `apps/web/app/(dashboard)/mcp/page.tsx`
- `apps/web/app/(dashboard)/settings/page.tsx`
- `apps/web/app/(auth)/forgot-password/page.tsx`
- `apps/api/src/routes/v1/auth.ts`
- `apps/api/src/routes/v1/llm-providers.ts`
- `apps/api/src/services/agent.service.ts`
