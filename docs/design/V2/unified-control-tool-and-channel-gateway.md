# V2 设计：统一控制工具（control_plane）与通用 Channel Gateway

## 1. 目标

本次升级把 `rule_authoring` 从“只管规则”升级为“可治理 Semibot 控制面”的统一工具，并统一命名为 `control_plane`，覆盖：

1. 规则管理（现有能力保留）
2. 技能安装/启停/卸载
3. MCP Server 管理与 Agent 绑定
4. Channel（原 Gateway 配置页）管理
5. Agent 管理
6. 平台配置 CRUD（LLM 路由、工具策略、审批策略等）

同时将接入层语义明确为：

- `Channel`：Feishu / Telegram / CLI / Web UI 等交互通道
- `Gateway`：连接 `Channel <-> Runtime` 的标准化路由层（内部概念）

---

## 2. 架构原则

## 2.1 分层职责

- `Channel Adapter`：各通道协议适配（鉴权、消息收发、文件上传下载）
- `Gateway Router`：统一事件模型、地址识别、上下文注入、任务分发、结果回传
- `Runtime`：规划、执行、工具调用、规则引擎
- `Control Plane Tool`（`control_plane`）：通过受控 API 修改控制面状态

## 2.2 命名与对外 API

- UI/API 对外统一使用 `channels/*`
- 内部代码可保留 `gateway/*` 模块名（表示连接层角色）
- 禁止在对外文案继续使用“Gateway=通道实例”的混合语义
- 删除旧 `gateway*` 对外路由，不再保留兼容入口

## 2.3 控制面与工具同步升级

- 控制面升级必须同步升级 `control_plane` 工具（参数、示例、错误码、回滚逻辑）。
- 不允许出现“控制面 API 已变更，工具仍使用旧 schema”的发布状态。
- 发布门禁：
  - 任何 `control` API schema 变更，必须同时提交 `control_plane` schema 与文档更新。
  - 必须新增/更新对应 E2E：至少 1 条成功路径 + 1 条失败回滚路径。
- 版本对齐：
  - `control_plane_capability_version` 必须等于 `control_plane_api_version`。
  - 版本不一致时：阻断写操作（create/update/delete/enable/disable/install/uninstall/bind/unbind），只允许 `list/get/test`，并返回 `CONTROL_PLANE_VERSION_MISMATCH`。
- 兼容窗口：
  - 旧协议最多保留一个小版本（V2.x），超窗后移除旧别名与旧字段。

---

## 3. 工具升级设计（control_plane）

## 3.1 工具定位

- 工具名：`control_plane`
- 兼容策略：保留 `rule_authoring` 作为只读别名一个版本周期（V2.x），随后移除
- 能力升级为：`control_authoring` 子域集合（通过 `domain + action` 路由）

统一输入：

```json
{
  "domain": "rules|skills|mcp|channels|agents|config",
  "action": "create|update|delete|enable|disable|list|get|test|bind|unbind|install|uninstall",
  "payload": {},
  "options": {
    "dry_run": false,
    "idempotency_key": "optional",
    "reason": "optional"
  }
}
```

## 3.2 领域操作矩阵

- `rules`：create/update/enable/disable/delete/list/get/simulate
- `skills`：install/uninstall/enable/disable/list/get
- `mcp`：create/update/delete/list/get/bind/unbind/test
- `channels`：create/update/delete/list/get/test/enable/disable
- `agents`：create/update/delete/list/get/enable/disable
- `config`：get/update（按命名空间：llm/tools/approval/runtime）

## 3.3 风险与审批

- 每个 `domain.action` 有默认风险等级
- 默认策略：全部放行（`requiresApproval=false`）
- 后续若要收紧，仅在工具配置中开启审批（不引入角色系统）
- 审批规则来源：
  - 工具级 `requiresApproval`
  - 操作级风险映射表（优先级更高）
  - 运行时策略覆盖（管理员策略）

---

## 4. 通用 Channel Gateway 设计

## 4.1 可扩展模型

新增通道只需要提供：

1. `ChannelAdapter`（入站/出站）
2. `ChannelCapability` 声明（text/file/card/reply/mention 等）
3. `AuthSpec`（token/webhook secret/signature）
4. `AddressingPolicy`（mention_only/all_messages/reply_to_bot）

Gateway Router 负责统一：

- 消息标准化：`channel.message.received`
- 附件标准化：`channel.file.received`
- 执行回传：`channel.message.send` / `channel.file.send`
- 会话键：`channel_id + bot_id + chat_id`

## 4.2 对 runtime 的统一注入

Gateway 在提交 runtime 前注入：

- 当前 `channel_id`
- `conversation_id`
- `gateway_context_id`
- 可回传目标（reply target）
- 可用于 notify 的 `channel_instance_id`

这样 `control_plane` 创建 `cron + notify` 时可以自动绑定目标 channel。

---

## 5. “详细接口说明注入 Runtime”方案

## 5.1 目标

让 LLM 能正确 tool use：知道每个操作的参数、约束、错误恢复方式，减少“缺参数/错 action”。

## 5.2 注入包（Control API Instruction Pack）

运行时启动时生成并注入一份结构化说明（由实际服务能力动态生成）：

- 操作清单（domain/action）
- 每个动作的：
  - 参数 schema（字段、类型、必填、默认值）
  - 示例（最小/完整）
  - 前置条件
  - 风险等级与审批要求
  - 常见错误码与恢复建议
  - 幂等建议

建议格式：

- 机器可读：JSON schema registry
- LLM 可读：Markdown 手册（简洁、按 domain 分组）

注入位置：

- Planner system prompt（摘要版）
- Tool descriptor（精简参数版）
- Context provider（按需展开详版）

## 5.3 版本一致性

- `instruction_pack_version` 与 runtime build/version 绑定
- 工具调用请求附带 `expected_pack_version`
- 版本不一致时返回 `INSTRUCTION_VERSION_MISMATCH` 并触发重取
- 同时校验 `control_plane_capability_version == control_plane_api_version`

---

## 6. 防递归调用设计（关键）

必须避免工具直接/间接调用自己（例如通过创建规则触发再次调用 `control_plane`）。

## 6.1 硬约束

- `control_plane` 内禁止发起 `control_plane` 工具调用（直接自调用一律拒绝）
- 动作路由层检测调用链：
  - 若 `call_stack` 已包含 `control_plane`，拒绝再次进入
  - 返回 `TOOL_RECURSION_BLOCKED`

## 6.2 规则层约束

- 禁止创建“触发后执行 `control_plane`”的规则动作（默认 deny）
- 仅管理员显式开启 `allow_control_plane_as_rule_action=true` 时可用（默认 false）

## 6.3 图检测

- 对 `domain.action` 建有向图，创建/更新规则时做环检测
- 检测到潜在环：`CONTROL_FLOW_CYCLE_DETECTED`

---

## 7. API 契约（新增/收敛）

对外统一前缀：

- `/api/v1/channels/*`（前端与外部）

控制面统一入口（供 `control_plane` 内部调用）：

- `/v1/control/{domain}/{action}`（runtime 内部）

示例：

- `POST /v1/control/rules/create`
- `POST /v1/control/channels/update`
- `POST /v1/control/mcp/bind`
- `POST /v1/control/skills/install`

说明：`control_plane` 不直接拼接各业务 API，而通过 `control service` 单入口路由，统一审计、审批、风控、幂等。

单一真源（Single Source of Truth）：

- `channels` 配置的持久化真源为 runtime SQLite（`~/.semibot/semibot.db`）
- API 层仅做代理/编排，不保存独立副本，不做双写
- 前端只调用 `/api/v1/channels/*`

---

## 8. 审计与可观测性

每次调用写审计事件：

- `control.requested`
- `control.approved` / `control.rejected`
- `control.executed`
- `control.failed`

关键字段：

- `domain` / `action`
- `payload_hash`（敏感字段脱敏后）
- `risk_level`
- `approval_id`
- `operator`（channel user / system）
- `idempotency_key`
- `tool_call_id`

---

## 9. 迁移计划

1. 阶段 A：保留旧 `rule_*` action，新增 `domain+action`（双栈）
2. 阶段 B：前端/Agent 提示词切到新协议
3. 阶段 C：删除旧 action 入口；删除旧 `gateway*` 对外路由

---

## 10. 验收标准

- 可以通过 `control_plane` 完成 skills/mcp/rules/channels/agents/config 的基础 CRUD
- 新增 channel 类型不需要改 runtime 主流程（只加 adapter）
- LLM 调用错误率显著下降（缺参、非法 action）
- 递归调用被稳定拦截，无死循环任务
- `/channels/*` 成为唯一对外主路径
- `cron` 调度默认使用宿主机器时区
- 涉及多步控制操作时，失败必须强一致回滚（无部分成功残留）

---

## 12. 已确认决策（本轮澄清）

1. `control_plane` 不允许直接修改 LLM 默认/回退模型（可建议，不可落地）。
2. 审批策略默认全部放行。
3. 不引入角色系统（单机简化模型）。
4. `channels` 单一真源为 runtime SQLite，API 为代理层。
5. `cron` 使用电脑（宿主机）时区。
6. 不允许工具自调用自己（直接阻断）。
7. 控制面多步操作采用强一致回滚。
8. 删除旧 `gateway*` 对外路由，仅保留 `channels*`。

---

## 13. 实施状态（当前）

- 已完成：
  - `control_plane` 主工具名 + `rule_authoring` 兼容别名
  - `rules/channels/mcp/skills/config` 五个 domain 的首版实现
  - 版本门禁（`CONTROL_PLANE_VERSION_MISMATCH`）
  - 自调用阻断（`TOOL_RECURSION_BLOCKED`）
  - `llm` 命名空间写保护（`LLM_CONFIG_WRITE_BLOCKED`）
- 未完成：
  - `agents` domain 真实 CRUD（当前返回占位错误）
  - 跨 domain 多步事务的统一回滚编排器（目前按单操作原子执行）

---

## 11. E2E 用例（新增）

1. `@telegram`: “给我创建一个每天 9 点新闻简报并发到当前群”
   - 期望：create rule + cron upsert + notify 绑定当前 channel instance
2. “安装一个 skill 并绑定到 agent A”
   - 期望：skills.install + agents.update 成功，审计可追踪
3. “新增 MCP server 并绑定 agent”
   - 期望：mcp.create + mcp.bind 成功
4. 递归防护
   - 输入：要求创建一个会再次调用 control_plane 的规则
   - 期望：被拒绝，返回 `TOOL_RECURSION_BLOCKED` 或 `CONTROL_FLOW_CYCLE_DETECTED`
5. 指令包版本不一致
   - 期望：返回 `INSTRUCTION_VERSION_MISMATCH` 并触发重取说明包
