# Semibot V2 CLI 设计方案（完整稿）

> 版本：2.0  
> 日期：2026-02-26  
> 状态：Ready

## 1. 文档目标

本文定义 Semibot V2 的 CLI 规范，覆盖：

1. 命令体系与参数语义  
2. 输出与错误契约  
3. 事件引擎、编排器、审批、记忆、工具/MCP/技能的入口约束  
4. 与 HTTP API 的映射和测试验收标准  

设计基线来源：

- `architecture.md`
- `engine-orchestrator-boundary.md`
- `event-processing.md`
- `implementation-spec.md`
- `api-contracts.md`
- `acceptance-criteria.md`

---

## 2. 设计原则与边界

## 2.1 原则

1. CLI 是主入口，Web UI 是可选管理面板，TUI 暂不优先。  
2. CLI 负责“入口编排与交互”，不承担业务核心逻辑。  
3. 规则先行，Agent 兜底；高风险动作默认 HITL。  
4. 自动化优先：稳定退出码、统一 JSON、无交互模式可脚本化。  

## 2.2 边界（强约束）

1. CLI 不直接拼接 SQL。  
2. CLI 不直接调用 Tool/MCP 实现细节绕过 Event Engine。  
3. CLI 不实现规则判定与任务计划，统一下沉到服务层与 Orchestrator。  

---

## 3. 总体架构

```text
semibot (CLI entry)
  -> cli.commands.*            # 参数解析、输出格式、交互确认
  -> application services      # ChatService/EventService/RuleService/...
  -> Event Engine + Orchestrator
  -> Tools / MCP / Skills / Memory
  -> SQLite + local files
```

运行模式：

1. `local`（默认）：进程内调用，低延迟。  
2. `remote`（可选）：CLI 通过 HTTP API 调用远端实例（`--endpoint`）。  

---

## 4. CLI 通用规范

## 4.1 命令语法

```bash
semibot [global-options] <command> [subcommand] [args]
```

## 4.2 全局参数

| 参数 | 说明 |
|---|---|
| `--profile <name>` | 选择 profile，默认 `default` |
| `--config <path>` | 配置文件路径，默认 `~/.semibot/config.toml` |
| `--db <path>` | SQLite 路径，默认 `~/.semibot/semibot.db` |
| `--workdir <path>` | 工作目录，限制文件类操作边界 |
| `--endpoint <url>` | 切换 remote 模式 |
| `--json` | 输出统一 JSON |
| `--output <table|json|yaml|ndjson>` | 输出格式 |
| `--quiet` | 最小输出 |
| `--verbose` | 详细日志 |
| `--trace-id <id>` | 强制指定链路追踪 ID |
| `--timeout <sec>` | 命令超时 |
| `--yes` | 跳过确认 |
| `--no-color` | 关闭 ANSI 颜色 |

## 4.3 配置优先级

`CLI 参数 > 环境变量 > profile 配置 > 默认值`

## 4.4 输出封装（JSON）

成功：

```json
{
  "ok": true,
  "data": {},
  "trace_id": "trc_xxx",
  "version": "2.0.0"
}
```

失败：

```json
{
  "ok": false,
  "error": {
    "code": "RULE_VALIDATION_ERROR",
    "message": "invalid action_mode",
    "details": {}
  },
  "trace_id": "trc_xxx",
  "version": "2.0.0"
}
```

## 4.5 退出码

| Code | 含义 |
|---|---|
| `0` | 成功 |
| `2` | 参数错误 |
| `3` | 配置错误 |
| `4` | 资源不存在 |
| `5` | 审批未通过 / 风险阻断 |
| `6` | 外部依赖失败（网络/MCP） |
| `7` | 超时 |
| `8` | 内部错误 |

---

## 5. 完整命令树（V2）

```bash
# 基础
semibot init
semibot doctor
semibot version
semibot configure [--config-path <path>] [--section <name>] [--non-interactive]
semibot configure show
semibot configure get <dotted.key>
semibot configure set <dotted.key> <value> [--type auto|string|int|float|bool|json]
semibot configure unset <dotted.key>

# 执行
semibot chat [--agent <id>] [--session <id>] [--stream]
semibot run "<task>" [--agent <id>] [--model <model>] [--json]
semibot serve [--host 127.0.0.1] [--port 8765] [--ui]

# 事件
semibot events list [--type <event_type>] [--since <ISO8601>] [--limit 50]
semibot events show <event_id>
semibot events replay <event_id>
semibot events replay --type <event_type> --since <ISO8601>
semibot events publish <event_type> --subject "<subject>" --payload '{"k":"v"}'
semibot events clean [--before <ISO8601>] [--dry-run]
semibot events stats [--since <ISO8601>]
semibot events queue

# 规则
semibot rules list [--active]
semibot rules show <rule_id>
semibot rules create --file ./rule.json
semibot rules update <rule_id> --file ./rule.patch.json
semibot rules enable <rule_id>
semibot rules disable <rule_id>
semibot rules lint --file ./rule.json
semibot rules test --event ./fixtures/event.json --rules ./fixtures/rules.json

# 审批
semibot approvals list [--status pending]
semibot approvals show <approval_id>
semibot approvals approve <approval_id> --reason "manual review passed"
semibot approvals reject <approval_id> --reason "risk too high"
semibot approvals watch

# 记忆
semibot memory search "<query>" [--category knowledge] [--limit 10]
semibot memory write --category project --importance 0.9 --content "..."
semibot memory sessions <session_id> [--limit 50]
semibot memory consolidate <session_id> [--dry-run]
semibot memory stats

# 会话
semibot sessions list
semibot sessions show <session_id>
semibot sessions export <session_id> --format md --out ./session.md
semibot sessions resume <session_id>

# 技能 / MCP / 工具
semibot skills list
semibot skills install <git_or_registry_url>
semibot skills validate <skill_name>
semibot skills remove <skill_name>

semibot mcp list
semibot mcp test <server_name>
semibot mcp sync
semibot mcp call <server_name> <tool_name> --args '{"path":"./"}'

semibot tools list
semibot tools run <tool_name> --args '{"query":"latest AI news"}'
```

---

## 6. 命令组行为规范

## 6.1 基础命令（`init/doctor/version/configure`）

### `semibot init`

1. 创建默认目录结构与基础配置。  
2. 初始化 SQLite（若不存在）。  
3. 可重复执行，重复执行不破坏已有数据。  

### `semibot doctor`

1. 检查目录、数据库、规则、技能、MCP 配置可达性。  
2. 输出 `checks` 列表，标记 `ok/warn/fail`。  
3. 有失败项时返回非 0。  

### `semibot version`

返回 CLI 版本、Python 版本、构建元信息。

### `semibot configure`（默认进入交互式向导）

默认按 TTY 进入交互向导；非交互场景使用 `show/get/set/unset`，详见第 7 节。

## 6.2 执行命令（`chat/run/serve`）

### `semibot run`

1. 触发 Orchestrator 单次任务执行。  
2. 自动生成 `session_id`（可显式指定）。  
3. 过程事件写入 Event Engine。  
4. `--json` 输出必须包含 `task/status/session_id/final_response`。  

### `semibot chat`

1. 交互式会话，支持 `--stream`。  
2. 每轮消息写短期记忆，会话结束可触发沉淀。  
3. 支持 `--message` 单轮执行并退出。  

### `semibot serve`

1. 启动 HTTP API 服务。  
2. `--reload` 仅用于本地开发。  
3. `--ui` 打开可选 Web 管理界面路由。  

## 6.3 事件命令（`events`）

### `events list`

- 支持 `event_type/since/limit` 过滤。  
- 默认按时间倒序。  

### `events show`

- 按 `event_id` 查询单事件详情。  

### `events replay`

1. 支持按 `event_id` 回放。  
2. 支持批量回放（`--type + --since`）。  
3. 回放前强制幂等校验与风险策略检查。  
4. 输出 `accepted/replay_id/summary`。  

### `events publish`

1. 接收 `event_type/subject/payload` 构造标准事件。  
2. payload 为 JSON 字符串。  
3. 支持 `idempotency_key` 和 `risk_hint`。  

### `events clean`

1. 清理历史事件与关联运行记录。  
2. 默认二次确认，可用 `--yes` 跳过。  
3. `--dry-run` 仅输出将删除的数量。  

### `events stats` / `events queue`

- `stats`：输出吞吐、类型分布、失败率、去重率。  
- `queue`：输出当前待处理队列快照。  

## 6.4 规则命令（`rules`）

### `rules list/show`

- 列出规则摘要，按优先级排序。  
- `show` 返回条件、动作、治理参数全量配置。  

### `rules create/update`

1. 输入文件遵循 `event-processing.md` 规则结构。  
2. 创建和更新都执行 schema 校验。  
3. 校验失败返回 `RULE_VALIDATION_ERROR`。  

### `rules enable/disable`

- 修改 `is_active`，写审计。  
- `disable` 默认二次确认。  

### `rules lint`

- 仅校验规则文件，不写入存储。  

### `rules test`

- 输入一条事件和一组规则，输出匹配与决策结果。  
- 不执行真实动作。  

## 6.5 审批命令（`approvals`）

### `approvals list/show`

- 查询审批请求及状态。  

### `approvals approve/reject`

1. 仅允许 `pending -> approved/rejected`。  
2. 写审批审计并发布 `approval.approved/rejected` 事件。  
3. 返回最终状态和关联 `event_id`。  

### `approvals watch`

- 流式订阅审批状态变更。  
- 支持 `Ctrl+C` 优雅退出。  

## 6.6 记忆命令（`memory`）

### `memory search`

- 检索长期记忆，支持 `category` 过滤和 `limit`。  
- 返回相似度和命中内容摘要。  

### `memory write`

- 显式写入长期记忆，支持 `category/importance/metadata`。  

### `memory sessions`

- 查看某会话短期记忆（最近 N 条）。  

### `memory consolidate`

- 将会话短期记忆沉淀到长期记忆。  
- `--dry-run` 仅输出候选，不落库。  

### `memory stats`

- 返回记忆总量、分类分布、向量索引状态。  

## 6.7 会话命令（`sessions`）

### `sessions list/show`

- 查询会话索引与详情。  

### `sessions export`

- 支持导出 `md/json`。  
- 导出结果附 trace 信息和时间范围。  

### `sessions resume`

- 继续指定会话并注入短期上下文。  

## 6.8 Skills / MCP / Tools

### `skills`

- `list`：列出安装技能。  
- `install`：安装本地或远端技能包。  
- `validate`：校验 `SKILL.md` 和目录结构。  
- `remove`：删除技能（默认确认）。  

### `mcp`

- `list`：读取 `mcp.json` 展示服务状态。  
- `test`：连通性自检。  
- `sync`：重载配置。  
- `call`：透传一次工具调用（需 JSON 参数）。  

### `tools`

- `list`：列出可用内建工具及参数 schema。  
- `run`：执行单工具；输出 `result/error/duration_ms`。  

---

## 7. `semibot configure` 详细规范（交互式）

## 7.1 设计目标

`configure` 是 V2 必须能力，采用“向导优先、脚本兼容”：

1. 终端用户执行 `semibot configure` 时进入交互向导（体验对齐截图风格）。  
2. 自动化脚本可继续用 `show/get/set/unset`。  
3. 向导流程需可恢复、可取消、可预览差异后提交。  

## 7.2 命令定义

```bash
semibot configure [--config-path <path>] [--section <name>] [--non-interactive]
semibot configure show [--config-path <path>]
semibot configure get <dotted.key> [--config-path <path>]
semibot configure set <dotted.key> <value> [--type auto|string|int|float|bool|json] [--config-path <path>]
semibot configure unset <dotted.key> [--config-path <path>]
```

说明：

- `semibot configure`：交互式向导（仅 TTY）。  
- `--section <name>`：直接进入指定 section（如 `runtime`、`llm`）。  
- `--non-interactive`：跳过向导，输出当前配置摘要（等价 `show`）。  

## 7.3 交互流程（对齐截图）

`semibot configure` 的默认流程：

1. 展示 header/badge（版本、模式、配置路径）。  
2. 检测并展示 Existing config 卡片（关键项摘要）。  
3. 选择配置模式（`Quick edit` / `Advanced`）。  
4. 进入 `Select sections to configure` 多选列表。  
5. 逐 section 配置并即时校验。  
6. 展示变更 diff（old -> new）。  
7. 确认保存并可选执行 `doctor` 自检。  

section 规则（V2）：

1. section 菜单由 `config.toml` 的顶层 table 动态生成。  
2. 内置优先展示 `runtime`、`llm`（与当前默认配置一致）。  
3. 允许 `Custom key`（dotted key）编辑未在向导表单中显式暴露的项。  
4. 始终保留 `Continue` 作为提交流程入口。  

当前默认配置下的典型 section：

- `Runtime`（`db_path`、`rules_path`、`skills_path`）  
- `LLM`（`default_model`）  
- `Custom key`（高级键值编辑）  
- `Continue`（进入保存确认）  

## 7.4 交互键位与可用性

1. `↑/↓` 或 `j/k`：移动光标。  
2. `Space`：多选勾选。  
3. `Enter`：确认进入下一步。  
4. `Esc`：返回上一层。  
5. `Ctrl+C`：取消并不写入。  

额外约束：

1. 无 TTY 时不进入向导，自动回退到 `--non-interactive` 行为。  
2. `--json` 在向导模式下输出最终结果摘要，不输出逐步 UI。  
3. 敏感字段（token/key）输入时必须 masked。  

## 7.5 路径解析规则

优先级：

1. 子命令显式 `--config-path`  
2. 全局 `--config`  
3. `SEMIBOT_CONFIG`  
4. `${SEMIBOT_HOME}/config.toml`  
5. `~/.semibot/config.toml`  

## 7.6 键路径规则

1. 使用 dotted key，例如 `llm.default_model`。  
2. `set` 时中间表不存在则自动创建。  
3. `unset` 仅删除目标键，不自动删除空父表。  
4. 空 key 视为参数错误，退出码 `2`。  

## 7.7 值类型规则

`set --type` 支持：

- `string`：按字符串写入  
- `int`：整数  
- `float`：浮点数  
- `bool`：支持 `true/false/1/0/yes/no/on/off`  
- `json`：按 JSON 解析（对象/数组/数字/布尔）  
- `auto`：先按 JSON 解析，失败则降级为字符串  

## 7.8 写入与一致性

1. 写入前必须先校验 TOML 可解析。  
2. 建议原子写入（临时文件 + rename）。  
3. 写入失败时不得破坏原文件。  
4. 向导模式仅在最终确认后一次性落盘。  
5. 取消向导不产生任何持久化变更。  

## 7.9 典型示例

```bash
# 进入交互式配置向导（默认）
semibot configure

# 直接进入某个 section
semibot configure --section llm

# 非交互查看（CI/脚本）
semibot configure --non-interactive
semibot configure show

# 读取某个配置
semibot configure get llm.default_model

# 写字符串
semibot configure set llm.default_model gpt-4o --type string

# 写布尔
semibot configure set runtime.enable_events true --type bool

# 写 JSON 对象
semibot configure set mcp.headers '{"Authorization":"Bearer xxx"}' --type json

# 删除配置
semibot configure unset mcp.headers
```

---

## 8. 安全与治理

1. 高风险动作默认进入审批流。  
2. `events clean`、`rules disable`、`skills remove` 默认确认。  
3. 文件写操作默认限制在 `--workdir`。  
4. 远程模式屏蔽敏感字段明文输出（token/key/header）。  
5. 审批与回放必须关联 `trace_id` 并写审计。  

---

## 9. CLI 与 HTTP API 映射

| CLI | HTTP API |
|---|---|
| `run` | `POST /v1/tasks/run` |
| `chat` | `POST /v1/chat` |
| `events list` | `GET /v1/events` |
| `events replay` | `POST /v1/events/replay` |
| `events publish` | `POST /v1/webhooks/{event_type}` |
| `rules list` | `GET /v1/rules` |
| `rules create` | `POST /v1/rules` |
| `approvals approve/reject` | `POST /v1/approvals/{id}/approve|reject` |
| `mcp test` | `POST /v1/mcp/{server}/test`（规划） |
| `configure` | 本地文件能力（可选扩展 API） |

---

## 10. 测试与验收

## 10.1 测试分层

1. 单元：参数解析、类型转换、错误映射、退出码。  
2. 集成：CLI -> 服务层 -> SQLite（events/rules/approvals/memory）。  
3. E2E：`run`、`events replay`、`approvals approve`、`configure` 交互向导、`configure set/get/unset`。  

## 10.2 Phase 对齐

- Phase 3：`pip install semibot && semibot chat` 可运行，首次启动自动初始化。  
- Phase 4：`events/rules/approvals` 命令可用，治理链路可验证。  
- Phase 5：群聊审批与进化闭环可从 CLI 观测与操作。  

---

## 11. 实施里程碑

## M1（P0）

- `init/doctor/version/configure`  
- `chat/run/serve`  
- `events list/show/replay/publish`  
- `rules list/show/enable/disable`  
- `approvals list/show/approve/reject`  
- 统一 JSON 与退出码  

## M2（P1）

- `events clean/stats/queue`  
- `rules create/update/lint/test`  
- `memory write/sessions/consolidate/stats`  
- `sessions list/show/export/resume`  

## M3（P1+）

- `skills install/validate/remove`  
- `mcp test/sync/call`  
- `approvals watch`  
- shell completion（bash/zsh/fish）  

---

## 12. 默认目录与环境变量

默认目录：

```text
~/.semibot/
  config.toml
  semibot.db
  mcp.json
  rules/
  skills/
  logs/
```

关键环境变量：

- `SEMIBOT_HOME`
- `SEMIBOT_PROFILE`
- `SEMIBOT_LOG_LEVEL`
- `SEMIBOT_CONFIG`
- `SEMIBOT_FEISHU_VERIFY_TOKEN`
- `SEMIBOT_FEISHU_WEBHOOK_URL`

---

## 13. 附录：默认配置模板（示例）

```toml
[runtime]
profile = "default"
workdir = "."
enable_events = true

[llm]
default_model = "gpt-4o"
temperature = 0.2

[events]
auto_publish = true
retention_days = 30

[approval]
high_risk_default = "ask"

[memory]
consolidate_on_session_end = true
```
