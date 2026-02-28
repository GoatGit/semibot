# Tools 配置矩阵（V2）

> 目标：统一说明内建工具可配置项、默认值、风险等级与审批策略，减少前后端/运行时理解偏差。  
> 生效源：`~/.semibot/semibot.db` → `tool_configs.config_json`

## 1. 内建工具总览

| Tool | 风险默认 | 审批默认 | 主要用途 |
|------|----------|----------|----------|
| `search` | low | false | 通用网页搜索 |
| `code_executor` | high | true | Python/JS/Shell 代码执行 |
| `file_io` | high | true | 本地文件读写 |
| `browser_automation` | high | true | 浏览器自动化操作 |
| `http_client` | high | true | 通用 REST 调用 |
| `web_fetch` | low | false | 轻量网页抓取与正文抽取 |
| `json_transform` | low | false | JSON 结构化转换 |
| `csv_xlsx` | high | true | CSV/Excel 处理 |
| `pdf_report` | low | false | 模板化 PDF 报告生成 |
| `sql_query_readonly` | high | true | 只读 SQL 查询 |

说明：
- `xlsx` / `pdf` 仍作为技能类能力（skill-like tools）存在，不属于可配置内建 Tool 集合。
- 风险与审批可在配置中心覆盖；未配置时运行时按工具默认策略兜底。

## 2. 通用字段（所有工具）

| 字段 | 类型 | 说明 |
|------|------|------|
| `timeout` | number(ms) | 超时阈值 |
| `requiresApproval` | boolean | 是否需要 HITL 审批 |
| `riskLevel` | `low \| medium \| high \| critical` | 风险等级 |
| `approvalScope` | `session \| session_action \| action \| target \| tool \| call` | 审批聚合粒度 |
| `approvalDedupeKeys` | string[] | 自定义审批去重键 |
| `rateLimit` | number | 速率限制（控制面字段） |

## 3. 工具专属字段

### 3.1 `browser_automation`

| 字段 | 类型 | 默认 |
|------|------|------|
| `headless` | boolean | `true` |
| `browserType` | `chromium\|firefox\|webkit` | `chromium` |
| `allowLocalhost` | boolean | `false` |
| `allowedDomains` | string[] | `[]` |
| `blockedDomains` | string[] | `["localhost","127.0.0.1","::1"]` |
| `maxTextLength` | number | `20000` |

### 3.2 `file_io`

| 字段 | 类型 | 默认 |
|------|------|------|
| `rootPath` | string | 用户主目录 |
| `maxReadBytes` | number | `200000` |

### 3.3 `http_client`

| 字段 | 类型 | 默认 |
|------|------|------|
| `apiEndpoint` | string(url) | `""` |
| `apiKey` | string | `""` |
| `retryAttempts` | number | `2` |
| `authType` | `none\|bearer\|basic\|api_key` | `none` |
| `authHeader` | string | `X-API-Key` |
| `allowLocalhost` | boolean | `false` |
| `allowedDomains` | string[] | `[]` |
| `blockedDomains` | string[] | `["localhost","127.0.0.1","::1"]` |
| `maxResponseChars` | number | `20000` |

### 3.4 `web_fetch`

| 字段 | 类型 | 默认 |
|------|------|------|
| `allowLocalhost` | boolean | `false` |
| `allowedDomains` | string[] | `[]` |
| `blockedDomains` | string[] | `["localhost","127.0.0.1","::1"]` |
| `maxResponseChars` | number | `20000` |

### 3.5 `json_transform`

无专属强约束字段，使用通用字段即可。

### 3.6 `csv_xlsx`

| 字段 | 类型 | 默认 |
|------|------|------|
| `rootPath` | string | 用户主目录 |
| `maxReturnRows` | number | `500` |
| `sheetName` | string | `"Data"` |

### 3.7 `pdf_report`

无专属强约束字段，使用通用字段即可。

### 3.8 `sql_query_readonly`

| 字段 | 类型 | 默认 |
|------|------|------|
| `maxRows` | number | `200` |
| `defaultDatabase` | string | `""` |
| `allowedDatabases` | string[] | `[]` |
| `connections` | object | `{}` |
| `dsn` / `databaseUrl` / `apiEndpoint` | string | `""` |

说明：
- `connections` 建议格式：`{ "main": "postgresql://...", "analytics": "sqlite:///..." }`
- 执行时必须满足：数据库别名在白名单（若配置白名单）、查询语句只读、单语句、超时与行数限制生效。

## 4. 控制面校验（当前实现）

`apps/api/src/routes/v1/tools.ts` 对以下专属字段做显式校验：
- `maxTextLength`: `100 ~ 500000`
- `maxResponseChars`: `100 ~ 500000`
- `maxRows`: `1 ~ 5000`
- `defaultDatabase`: `<= 200 chars`
- `allowedDatabases`: `string[]`，最多 100 项

其余扩展字段通过 `passthrough()` 透传，以兼容后续工具能力扩展。
