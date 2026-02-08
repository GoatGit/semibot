## Task: Skill 全流程应用补齐（创建 → 绑定 → 执行 → 观测）

**ID:** skill-lifecycle-end-to-end-implementation-plan  
**Label:** Semibot: Skill 从管理到主流程执行打通  
**Description:** 审查并补齐 Skill 在主流程中的端到端应用能力，确保创建后的 Skill 可被 Agent 实际调用并可观测  
**Type:** Feature Gap  
**Status:** Backlog  
**Priority:** P0 - Critical  
**Created:** 2026-02-08  
**Updated:** 2026-02-08  
**PRD:** N/A

---

### 审查范围

- 后端：`apps/api/src`（skills、agents、chat、sessions）
- 运行时：`runtime/src`（orchestrator、skills registry、executor）
- 前端：`apps/web/app/(dashboard)`（skills、agents）

### 现状与缺口（按流程）

#### 1) 创建 Skill（已具备基础能力）

- 已有能力：
  - `POST /skills`、`GET /skills`、`PUT /skills/:id`、`DELETE /skills/:id`
  - 位置：`apps/api/src/routes/v1/skills.ts`
  - 前端管理页可创建/启停/删除：`apps/web/app/(dashboard)/skills/page.tsx`
- 缺口：
  - Skill 的 `tools` 配置未做可用工具来源约束（未与 `/tools`、`/mcp` 联动校验）
  - 缺少“技能配置 schema 级校验”（不同 tool 类型的 config 约束）

#### 2) 绑定 Skill 到 Agent（后端支持，前端未打通）

- 已有能力：
  - Agent 接口支持 `skills: string[]`
  - 位置：`apps/api/src/routes/v1/agents.ts`、`apps/api/src/services/agent.service.ts`
- 缺口：
  - Agent 编辑页没有 Skill 多选绑定能力（当前页面只配基础字段/模型）
  - 未校验 Agent.skills 中 skillId 的有效性（是否存在、同组织、已启用）

#### 3) 主流程执行 Skill（核心缺口）

- 现状：
  - `chat.service` 仍是直接 LLM 流式回复路径，未读取/执行 `agent.skills`
  - 位置：`apps/api/src/services/chat.service.ts`
  - runtime 侧虽有 `skill_registry` / `action_executor` 能力，但未与 API chat 链路打通
  - 位置：`runtime/src/orchestrator/nodes.py`、`runtime/src/orchestrator/executor.py`
- 缺口：
  - API chat 未将会话请求提交到 runtime orchestrator（或未注入 agent skill 上下文）
  - runtime registry 未加载 DB 中的“租户自定义 Skill”
  - planner 可见技能集合与 Agent 绑定技能不一致（目前主要来自 registry 全量）

#### 4) 观测与调试（不足）

- 缺口：
  - 缺少 Skill 级执行日志（skill_id、tool_name、duration、success/error）
  - SSE 中缺少可区分的“skill_call / skill_result”事件规范（仅通用 tool_call/tool_result）
  - 缺少失败分类统计（参数校验失败、权限失败、工具超时、执行异常）

#### 5) 测试覆盖（不足）

- 现状：
  - `skill.service` 单测覆盖 CRUD
- 缺口：
  - 缺少端到端测试：创建 skill → 绑定 agent → 发起 chat → 触发 skill → 产出可观测结果
  - 缺少多租户隔离测试（A 组织 skill 不可被 B 组织调用）
  - 缺少禁用 skill 时主流程行为测试（应不可执行且返回可理解错误）

---

### 实施任务拆解

#### 阶段 A：数据与配置约束（P0）

- [ ] 在 `agent.service` 增加 `skills` 绑定校验（存在性、组织归属、isActive）
- [ ] 为 `skills` 的 `tools/config` 增加后端校验规则（按 tool 类型分支）
- [ ] 提供 `GET /skills/options`（仅返回可绑定、可执行的 skill 摘要）

#### 阶段 B：前端绑定入口（P0）

- [ ] Agent 详情页增加 Skill 多选器（读取 `/skills/options`）
- [ ] 保存 Agent 时提交 `skills` 列表并展示绑定状态
- [ ] 在 Agent 列表卡片增加已绑定 Skill 摘要与数量

#### 阶段 C：主流程打通（P0）

- [ ] API chat 链路改为走 runtime orchestrator（而非直接 LLM）
- [ ] runtime 在会话启动时按 `agent.skills` 构建/过滤 `skill_registry`
- [ ] planner 只暴露当前 Agent 可用技能（而非全局）
- [ ] act 节点执行 skill 时注入 org/session/user 上下文，支持权限与审计

#### 阶段 D：观测与错误处理（P1）

- [ ] 增加 Skill 执行日志表/记录字段（skill_id, tool, latency, status, error_code）
- [ ] SSE 增加 `skill_call` / `skill_result` 标准事件（前端可视化）
- [ ] 统一错误码：`SKILL_NOT_BOUND`、`SKILL_DISABLED`、`SKILL_EXECUTION_FAILED`

#### 阶段 E：测试与验收（P1）

- [ ] API 集成测试：创建 skill + 绑定 agent + chat 触发 skill
- [ ] Runtime 集成测试：registry 装载 DB 技能、按 agent 过滤执行
- [ ] E2E 测试：前端配置 skill 后在对话中可见调用链路
- [ ] 回归：停用 skill 不消失、删除 skill 不可再绑定/调用

---

### 验收标准

- [ ] 创建后的 Skill 可在 Agent 页面完成绑定并持久化
- [ ] 绑定 Skill 的 Agent 在真实 chat 中可触发并执行 Skill
- [ ] 未绑定/已禁用 Skill 不会被 planner 选中执行
- [ ] 前端可看到 skill 调用过程与结果（含失败原因）
- [ ] 全链路具备可观测日志与自动化测试覆盖

---

### 相关代码位置（当前）

- `apps/api/src/routes/v1/skills.ts`
- `apps/api/src/services/skill.service.ts`
- `apps/api/src/routes/v1/agents.ts`
- `apps/api/src/services/agent.service.ts`
- `apps/api/src/services/chat.service.ts`
- `apps/web/app/(dashboard)/skills/page.tsx`
- `apps/web/app/(dashboard)/agents/[agentId]/page.tsx`
- `runtime/src/orchestrator/nodes.py`
- `runtime/src/orchestrator/executor.py`
- `runtime/src/skills/registry.py`

