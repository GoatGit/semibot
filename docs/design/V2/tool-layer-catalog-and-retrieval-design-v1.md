# Semibot 工具层重构设计 V1

> 状态: Proposed
> 范围: Runtime / Orchestrator / API / Web
> 主题: Builtin Tool、MCP Tool、CLI Tool 三层工具源统一，结合分层检索与按需 schema 注入

## 1. 背景

当前 Semibot 的执行能力在实现上已经存在两条主路径：

- 内建 tool，由 runtime 的 registry 直接注册
- MCP tool，由运行时连接的 MCP server 动态暴露

与此同时，`skill` 仍然承担安装、文件包、说明文档、脚本资产和部分能力描述职责，但它已经不是最清晰的执行抽象。当前代码里甚至明确跳过了“把 skill 注册成 tool”这件事。

这带来三个问题：

1. 抽象混杂。`tool / skill / mcp` 混在一起，执行层和分发层没有彻底分开。
2. 扩展路径不统一。未来接任意本地 harness 时，没有明确的“第三类工具源”。
3. schema 注入不可扩展。如果继续把所有可用能力全量注入给 LLM，token 会持续膨胀，工具误选率会变高。

因此需要把执行能力明确收束成统一工具层，并把 skill 降级为“能力包层”。

## 2. 设计目标

本设计的目标不是引入更多概念，而是让现有能力源变得可治理、可扩展、可检索。

### 2.1 核心目标

1. 将执行能力统一为三类来源：
   - `builtin`
   - `mcp`
   - `cli`
2. 保留 `skill`，但把它定位为：
   - 安装包
   - 文档与脚本容器
   - 能力产物集合
3. 避免全量 schema 注入，改为：
   - 核心工具常驻
   - 目录卡片全量可见
   - 动态候选完整注入
4. 为未来 CLI harness 接入保留统一入口，但不把任何外部生态作为前置依赖。

### 2.2 非目标

1. 本设计不把所有 skill 直接转成 tool。
2. 本设计不允许“任意 shell 命令”直接成为 tool。
3. 本设计不要求第一阶段就引入向量数据库。
4. 本设计不直接替换现有 orchestrator graph，只对 capability 发现和 schema 注入做重构。

## 3. 术语与定位

本章需要明确一条原则：

- **Skill 不是一等执行原语，Tool 才是。**

这意味着：

- LLM 最终看到和调用的是 `tool`
- `skill` 主要负责能力打包、安装分发、说明文档和策略默认值
- `builtin / mcp / cli` 是 tool 的来源分类，不是 skill 的子类型

### 3.1 Tool

Tool 是可执行能力的统一抽象，供 LLM 在 act 阶段调用。

Tool 必须具备：

- 稳定的 `toolName`
- 明确的 description
- 可验证的 parameters schema
- 风险和权限元数据
- 统一的执行与返回契约

### 3.2 Skill

Skill 是能力包，不是主要执行对象。

Skill 用于：

- 安装与分发
- 文件系统存储
- `SKILL.md` 和脚本资产
- 默认 policy 和示例
- 包含一个或多个 tool manifests

Skill 可以产出多个 tools。

进一步约束如下：

1. `skill` 不与 `builtin / mcp / cli` 并列为同一级执行抽象。
2. `skill` 不应默认直接注入为 LLM 可调用 schema。
3. `skill` 的核心职责是：
   - 打包
   - 分发
   - 安装
   - 说明
   - 约束与策略默认值
4. `tool` 的核心职责是：
   - schema
   - 执行
   - 校验
   - 审批与风险控制

可以把关系理解为：

```text
skill = capability package layer
tool  = execution layer
```

### 3.3 Tool Source

统一定义三类工具来源：

- `builtin`: runtime 内建工具
- `mcp`: 来自 MCP server 的工具
- `cli`: 来自本地 CLI harness、OpenCLI adapter 或其他 CLI provider 的工具

### 3.4 Skill 与三类 Tool Source 的关系

为了避免实现再度滑回 “skill/tool 混用”，这里明确三条关系。

#### 3.4.1 Skill 与 Builtin Tool

关系较弱。

- builtin tool 属于平台级 runtime 能力
- 不依赖某个 skill 才存在
- skill 可以引用 builtin tool 的推荐使用方式
- 但 builtin tool 不属于某个 skill

因此：

- `builtin tool` 是平台能力
- `skill` 可以依赖它，但不拥有它

#### 3.4.2 Skill 与 CLI Tool

关系最强。

- skill 很适合承载 CLI tool manifests、脚本、示例和默认策略
- 一个 skill 可以产出多个 CLI tools
- 这是本设计中 skill 最自然的落点

例如：

```text
skills/opencli-browser/
├── SKILL.md
├── cli-tools/
│   ├── browser_search.json
│   ├── browser_extract.json
│   └── browser_click_path.json
└── policy.json
```

#### 3.4.3 Skill 与 MCP Tool

关系是间接依赖，而不是包含关系。

- MCP tool 属于外部 MCP server
- 不属于本地 skill package 资产
- skill 可以声明自己依赖某 MCP server
- skill 也可以为该 MCP tool 提供文档、工作流和约束
- 但不拥有它

因此：

- `skill` 可以依赖 `mcp server`
- 但不应把 `mcp tool` 视为 skill 内部工具

### 3.5 CLI Tool 是否必须通过 Skill 安装

不必须。

系统应支持两条并行路径：

1. 通过 `skill package` 安装 CLI tools
2. 由系统或管理员直接预装 CLI tools

这条区分非常重要，因为 CLI tool 的来源不只有 skill。

#### 3.5.1 允许系统预装 CLI Tool

系统可以预先安装一些 CLI tools，而不通过 skill 安装流程。

典型场景：

- 产品内置推荐的 CLI harness
- OpenCLI runtime/adapters
- 企业环境下管理员预装的内部 CLI 工具
- release 包自带的标准 CLI providers

这些工具可以直接进入 `cli tool provider` 的发现范围，然后注册进 unified tool catalog。

#### 3.5.2 通过 Skill 安装 CLI Tool

另一条路径是由 skill package 带出 CLI tools。

这适合：

- 社区扩展包
- 用户下载的能力包
- CLI-Anything 生成后再打包分发的 harness

#### 3.5.3 设计结论

因此，`cli tool` 和 `skill` 的关系应写成：

- `cli tool` 可以由 skill 提供
- `cli tool` 也可以独立存在并被系统预装
- skill 不是 CLI tool 的唯一安装来源

建议在数据模型中显式区分：

```ts
interface ToolCatalogEntry {
  sourceType: 'builtin' | 'mcp' | 'cli'
  providerId: string | null
  packageId?: string | null   // 可选，表示是否来自某个 skill package
}
```

这样运行时就能区分：

- `sourceType = cli, packageId = null`
  - 系统预装 CLI tool
- `sourceType = cli, packageId = some-skill`
  - 由 skill 包提供的 CLI tool

### 3.6 Skill 安装后是否自动安装其包含的工具

应当自动安装，但只限于 skill 自己“拥有”的工具，不包括其依赖的外部系统。

这是必须写清楚的边界，否则 skill 安装行为会变得不可预测。

#### 3.6.1 应自动安装的内容

当 skill package 内明确声明并携带了本地工具产物时，安装 skill 应自动完成这些工具的注册。

典型包括：

- skill 包内自带的 CLI tool manifests
- skill 包内脚本驱动的本地 harness
- skill 包内声明并能直接进入 unified tool catalog 的 local tools

也就是说：

- 安装 skill
- 同步安装它 `bundled` 的 tools

这符合用户心智，也符合运行时一致性。

#### 3.6.2 不应自动安装的内容

skill 安装不应自动处理它依赖但并不拥有的外部能力。

不应默认自动安装或自动接入的内容包括：

- builtin tools
  - 这些本来就是平台能力，不需要安装
- MCP servers
  - 这些属于外部连接与认证配置，不应在 skill 安装时偷偷接入
- system binaries
  - 例如宿主机上的某个 CLI 程序，不应无提示强行安装

因此，对这些依赖的处理方式应是：

- 校验
- 提示
- 必要时引导安装或配置

而不是隐式自动安装。

#### 3.6.3 推荐的 manifest 表达

建议在 skill manifest 中显式区分：

```ts
interface SkillPackageManifest {
  skillId: string
  bundledTools: string[]
  requiredBuiltinTools: string[]
  requiredMcpServers: string[]
  requiredSystemBinaries: string[]
}
```

语义如下：

- `bundledTools`
  - 安装 skill 时自动安装/注册
- `requiredBuiltinTools`
  - 仅校验是否存在
- `requiredMcpServers`
  - 仅校验/提示是否已连接
- `requiredSystemBinaries`
  - 仅校验/提示是否已安装

#### 3.6.4 安装结果的返回建议

安装 skill 后，系统应返回结构化结果，而不是只返回“安装成功”。

建议返回：

```json
{
  "skillInstalled": true,
  "bundledToolsInstalled": ["browser_search", "browser_extract"],
  "builtinDependenciesOk": ["file_io", "web_fetch"],
  "missingMcpServers": ["notion-mcp"],
  "missingSystemBinaries": ["opencli"]
}
```

这能明确告诉用户：

- skill 自带的工具已经装好了
- 哪些只是依赖
- 哪些还需要手动处理

### 3.7 是否需要 `tool_installer`

这一节描述的是后续扩展能力，不是 MVP 核心。

需要。

但 `tool_installer` 不应取代 `skill_installer`，而应与之分工明确。

这是因为系统在后续阶段会支持两条能力进入路径：

1. 通过 `skill package` 安装能力
2. 直接安装独立 tool，尤其是 `cli tool`

如果没有 `tool_installer`，系统会被迫把所有可安装能力都包装成 skill，导致抽象重新混乱。

#### 3.7.1 `skill_installer` 的职责

`skill_installer` 负责安装能力包，而不是直接承担所有 tool 的生命周期。

它负责：

- 安装 skill package
- 校验 skill 结构
- 写入 skill metadata
- 处理 `SKILL.md`、scripts、policy defaults
- 解析 `bundledTools`
- 校验 `requiredBuiltinTools`
- 校验 `requiredMcpServers`
- 校验 `requiredSystemBinaries`

适用对象：

- 社区 skill 包
- 用户上传的能力包
- CLI-Anything 生成后再打包的 skill bundle

#### 3.7.2 `tool_installer` 的职责

`tool_installer` 负责安装和注册独立工具，第一阶段主要面向 `cli tools`。

它负责：

- 安装 tool manifest
- 安装本地 CLI harness
- 注册 provider
- 执行 schema 校验
- 执行健康检查
- 写入 unified tool catalog
- 触发 tool reindex / runtime refresh

适用对象：

- 系统预装 CLI tools
- OpenCLI adapters
- 独立分发的 local harness
- 不经过 skill 包安装流程的工具

#### 3.7.3 `tool_installer` 不负责什么

`tool_installer` 不应直接处理：

- skill package 安装
- MCP server 创建与认证
- builtin tool 安装

原因：

- skill package 是 package 级事务
- MCP server 更接近连接配置，不是 tool 安装
- builtin tool 是平台内建能力，不存在“安装”语义

#### 3.7.4 推荐关系

二者应是组合关系，而不是互斥关系。

推荐链路：

```text
skill_installer
  -> install skill package
  -> validate dependencies
  -> call tool_installer for bundled tools
```

这意味着：

- `skill_installer` 负责包级事务
- `tool_installer` 负责工具级事务

这样既保留 skill 体系，也给独立 CLI tool 留出清晰入口。

#### 3.7.5 推荐命令与 API

CLI 建议：

```bash
semibot tools install --manifest ./tool.json
semibot tools install --path ./my-cli-tool
semibot tools reindex
semibot tools doctor
```

API 建议：

- `POST /v1/runtime/tools/install`
- `POST /v1/runtime/tools/reindex`
- `POST /v1/runtime/tools/doctor`

#### 3.7.6 设计结论

应同时保留：

- `skill_installer`
- `tool_installer`

其中：

- `skill_installer` 处理 package layer
- `tool_installer` 处理 execution layer 中可独立安装的 tool，优先是 `cli tools`

### 3.8 外部实践参考

这一节仅保留结论，不构成 MVP 或 Phase 1 的实现前提。

外部同类实践值得吸收的只有三点：

- 多来源自动发现
- load-time gating
- 安装/更新后的自动刷新

不应照搬的只有两点：

- `skills-first` 作为主要执行抽象
- 全量向模型注入所有可用能力

### 3.9 缺失能力解析（Missing Capability Resolution）

这一节定义的是目标闭环。MVP 只做其中的最小子集：

- `detect`
- `recommend`
- 人工安装
- `refresh`
- `retry`

approval / audit / install status 持久化属于后续强化项。

当用户提交一个任务，而当前 injected tool shortlist 无法满足执行要求时，系统需要进入“缺失能力解析”流程。

这里需要明确一条边界：

- **系统应支持自动发现缺失能力，但不应默认无条件自动安装。**

#### 3.9.1 目标

缺失能力解析的目标不是让模型任意扩展系统，而是让系统在“缺工具”时能走一条可治理、可审计、可回滚的补能力链路。

目标包括：

1. 自动判断当前能力是否不足
2. 自动检索可补充的 tool 或 skill
3. 给出推荐安装候选
4. 在批准后执行安装
5. 安装完成后刷新 catalog 并重试任务

#### 3.9.2 推荐主流程

推荐的默认流程如下：

```text
任务执行
  -> tool shortlist 不足
  -> 进入 missing capability resolution
  -> 检索 tool registry / skill registry
  -> 生成推荐候选
  -> 用户或策略批准
  -> 调用 tool_installer / skill_installer
  -> 刷新 tool catalog
  -> 重新规划并重试任务
```

也就是说，默认行为应是：

- 自动发现
- 自动推荐
- 批准后安装

而不是：

- 自动发现
- 自动安装

#### 3.9.3 默认模式：推荐安装，不默认自动安装

默认模式下，Semibot 应支持：

1. 判断当前缺失哪类能力
   - builtin 不足
   - mcp 未连接
   - cli tool 未安装
2. 检索 registry 中的候选项
   - tool registry
   - skill registry
3. 返回结构化推荐结果
   - 推荐 skill/tool
   - 安装后会新增哪些 tools
   - 风险等级
   - 是否需要额外依赖或凭据
4. 等待用户确认后再安装

这应作为默认产品行为。

原因：

- 安装是状态变更，不是普通 tool call
- 可能引入外部代码和新权限
- 可能依赖外部二进制、网络或认证配置
- 必须保证审计、回滚和安全边界

#### 3.9.4 受控自动安装模式

在满足严格策略时，系统可以支持自动安装，但不应作为默认行为。

建议仅在以下条件同时满足时允许：

- 来源可信
  - 官方 registry
  - 受信发布者
- 风险较低
  - low risk
  - 无高权限副作用
- 无额外认证要求
  - 不依赖新 secrets
  - 不要求接入外部账户
- 可回滚
  - 安装失败不会破坏现有运行态
  - 可清晰卸载

例如：

- 官方低风险 CLI tool
- 产品内置推荐 skill bundle

#### 3.9.5 三种运行模式

建议将缺失能力解析做成三档策略：

1. `recommend`
   - 自动发现缺失能力
   - 自动推荐候选
   - 需要用户批准后安装
2. `auto_low_risk`
   - 对低风险、官方来源候选自动安装
   - 其他情况仍需批准
3. `policy_controlled`
   - 企业或高级模式
   - 由管理员配置 allowlist / registry / publisher policy

默认值应为：

- `recommend`

#### 3.9.6 Tool 与 Skill 的检索顺序

缺失能力解析时，建议先检索 tool，再检索 skill。

原因：

- 如果已有独立可安装 tool，就不必引入更大的 package
- tool 安装的副作用通常小于 skill package 安装
- skill 应更多作为“能力包”和“工具集合”存在

建议顺序：

1. 查找可独立安装的 tool
2. 若没有合适 tool，再查找可补足能力的 skill package
3. 若 skill package 包含多个相关 tools，可整体推荐

#### 3.9.7 推荐返回格式

建议返回统一的结构化推荐结果：

```json
{
  "resolutionMode": "recommend",
  "missingCapability": {
    "intent": "control authenticated browser session"
  },
  "recommendedTools": [
    {
      "toolId": "opencli.browser_search",
      "sourceType": "cli",
      "installPath": "tool_installer",
      "riskLevel": "low"
    }
  ],
  "recommendedSkills": [
    {
      "skillId": "opencli-browser",
      "bundledTools": ["browser_search", "browser_extract"],
      "riskLevel": "medium"
    }
  ]
}
```

#### 3.9.8 与 OpenClaw 的差异

OpenClaw 明确支持：

- 已安装 skills 的自动发现
- 多目录自动加载
- hub 式搜索、安装、更新、同步

但本设计不依赖“按任务自动去远端安装新 skill”作为默认机制。

Semibot 在这方面的建议是：

- 吸收 OpenClaw 的发现与装载体验
- 但把“自动按任务安装能力”收束到受控策略之下

#### 3.9.9 设计结论

本设计对“缺失能力”的结论是：

- 可以自动发现缺少的能力
- 可以自动检索 registry 中的候选 tool / skill
- 默认应自动推荐，而不是自动安装
- 自动安装只应在受控策略下启用
- 安装完成后，必须刷新 catalog 并重试任务

### 3.10 Registry 数据模型

为了支撑“缺失能力解析”，完整形态下系统需要至少维护两类 registry：

- `tool registry`
- `skill registry`

但对 MVP 而言，只需要：

- 最小 `tool registry`
- 来自 skill package 的静态索引信息

不要求先做完整 `skill registry` 生命周期。

完整形态下二者职责不同：

- `tool registry` 负责回答“有没有一个可直接安装的 tool 能补足当前能力”
- `skill registry` 负责回答“有没有一个 package 能整体补足当前能力”

#### 3.10.1 Tool Registry Entry

建议的 `tool registry` 条目如下：

```ts
interface ToolRegistryEntry {
  toolId: string
  sourceType: 'builtin' | 'mcp' | 'cli'
  providerId: string | null
  packageId?: string | null
  toolName: string
  description: string
  summary: string
  tags: string[]
  aliases: string[]
  installable: boolean
  installPath: 'none' | 'tool_installer' | 'skill_installer'
  riskLevel: 'low' | 'medium' | 'high'
  publisher: {
    publisherId: string
    trusted: boolean
    official: boolean
  }
  dependencies: {
    requiredSystemBinaries: string[]
    requiredMcpServers: string[]
    requiredSecrets: string[]
  }
  retrieval: {
    keywords: string[]
    embeddingText: string
  }
}
```

这里要特别区分：

- `installable = false`
  - 当前只可连接或只可引用
- `installPath = tool_installer`
  - 独立可安装 tool
- `installPath = skill_installer`
  - 该 tool 实际由某个 skill package 提供

#### 3.10.2 最小 Skill 索引

MVP 不要求完整 `skill registry` 生命周期。

只需要最小 skill 索引信息，用于回答：

- 某个 skill 会带来哪些 bundled tools
- 它依赖哪些外部条件

这部分可以来自：

- 文件系统 manifest
- package metadata 扫描结果

#### 3.10.3 Registry 统一查询面

尽管内部有两类 registry，运行时仍应提供统一查询面：

```ts
interface MissingCapabilitySearchResult {
  recommendedTools: ToolRegistryEntry[]
  recommendedSkills: Array<{
    skillId: string
    skillName: string
    bundledTools: string[]
    requiredSystemBinaries: string[]
    requiredMcpServers: string[]
    riskLevel: 'low' | 'medium' | 'high'
  }>
}
```

这样 planner / resolver 层不需要自己理解 registry 存储实现。

### 3.11 推荐排序规则

MVP 不使用精确权重公式。

当前只需要一组可解释的优先级规则。

#### 3.11.1 排序优先级原则

推荐排序应遵循这些优先级：

1. 能直接补足能力的独立 tool，优先于更大的 skill package
2. 官方与受信来源，优先于未知来源
3. 低风险、低副作用安装，优先于高风险安装
4. 依赖更少的候选，优先于依赖更多的候选
5. 若 skill 能一次性补足一组强相关能力，可高于单个 tool

#### 3.11.2 MVP 排序输入

MVP 只使用这些信号：

- lexical match
- metadata filter
- installability
- trust level
- risk level

`embedding` 与 `usage prior` 均属于后续增强项，不应阻塞第一阶段实现。

### 3.12 `recommend -> approve -> install -> retry` 状态机

完整形态下，缺失能力解析可以有完整状态机。

但对 MVP 而言，只需要最小闭环：

```text
detect -> recommend -> install -> refresh -> retry
```

approval、audit、install-status 轮询属于后续治理强化。

#### 3.12.1 完整状态定义（Post-MVP）

建议定义如下状态：

```text
idle
  -> detecting_missing_capability
  -> searching_registry
  -> recommending
  -> awaiting_approval
  -> installing
  -> refreshing_catalog
  -> retrying_task
  -> completed

error_terminal
cancelled
```

其中：

- `recommending`
  - 系统已生成候选，但还未请求批准
- `awaiting_approval`
  - 已向用户或策略系统提交安装申请
- `installing`
  - 正在调用 `tool_installer` / `skill_installer`
- `refreshing_catalog`
  - 已安装完成，正在刷新 tool catalog / session state
- `retrying_task`
  - 重新构造 shortlist 并再次执行原任务

#### 3.12.2 MVP 主流转

```text
detecting_missing_capability
  -> searching_registry
  -> recommending
  -> installing
  -> refreshing_catalog
  -> retrying_task
  -> completed
```

MVP 异常分支只需要：

- `searching_registry -> completed` if no viable candidate
- `installing -> error_terminal`
- `refreshing_catalog -> error_terminal`
- `retrying_task -> error_terminal`

#### 3.12.3 完整状态流转（Post-MVP）

建议主流转如下：

```text
idle
  -> detecting_missing_capability
  -> searching_registry
  -> recommending
  -> awaiting_approval
  -> installing
  -> refreshing_catalog
  -> retrying_task
  -> completed
```

异常分支：

```text
searching_registry -> completed
  if no viable candidate and task should degrade gracefully

awaiting_approval -> cancelled
  if user rejects or policy denies

installing -> error_terminal
  if install fails

refreshing_catalog -> error_terminal
  if registry refresh fails

retrying_task -> error_terminal
  if new capability still cannot satisfy task
```

#### 3.12.4 审计与可观测性（Post-MVP）

每次缺失能力解析都应记录事件：

- 原始任务摘要
- 缺失能力判断结果
- 检索出的候选
- 最终批准项
- 安装结果
- 重试结果

建议至少记录：

```json
{
  "taskId": "tsk_123",
  "missingCapability": "authenticated_browser_control",
  "recommendedToolIds": ["opencli.browser_search"],
  "recommendedSkillIds": ["opencli-browser"],
  "approvedInstallTarget": "tool:opencli.browser_search",
  "installStatus": "succeeded",
  "retryStatus": "completed"
}
```

#### 3.12.5 失败后的处理

安装失败后不应直接把系统留在不确定状态。

建议处理规则：

1. `tool_installer` / `skill_installer` 必须提供原子失败语义
2. 安装失败后不得污染当前 catalog
3. `retrying_task` 只能在 `refreshing_catalog` 成功后进入
4. UI 需要明确区分：
   - 搜索失败
   - 安装失败
   - 重试失败

#### 3.12.6 设计结论

第一阶段先实现最小闭环，后续再补全治理状态机，不应反过来。

## 4. 为什么要拆成 Builtin / MCP / CLI

这是执行层最自然的切分，而不是为了分类而分类。

### 4.1 Builtin

特点：

- 稳定
- 高可控
- 高复用
- 直接受 Semibot runtime 管理

例如：

- `file_io`
- `search`
- `web_fetch`
- `memory`
- `code_executor`

### 4.2 MCP

特点：

- 外部 server 动态暴露
- 强依赖连接态、认证态和 server 健康
- 参数 schema 由外部系统提供

### 4.3 CLI

特点：

- 本地软件能力适配层
- 可来自 OpenCLI、CLI-Anything 生成物、手工注册 harness
- 适合接网站、Electron、本地程序、其他 CLI 工具

CLI 这一层是未来的能力扩展重点。

## 5. 总体架构

建议把能力层拆成三层：

1. `Capability Package Layer`
   - skill packages
   - manifests
   - docs
   - scripts
2. `Tool Catalog Layer`
   - builtin / mcp / cli 统一目录
   - 供检索和注入使用
3. `Execution Layer`
   - builtin executor
   - mcp executor
   - cli executor

### 5.1 关系图

```text
Skill Package
  ├── docs / scripts / SKILL.md
  ├── cli tool manifest(s)        ┐
  └── policy / examples           ┘
                                    └──> Tool Catalog -> Retriever -> Injected Schemas -> LLM

MCP Server -----------------------> Tool Catalog -> Retriever -> Injected Schemas -> LLM

Builtin Registry -----------------> Tool Catalog -> Retriever -> Injected Schemas -> LLM
```

## 6. 统一数据模型

建议新增 `ToolCatalogEntry`，作为三类工具的统一目录格式。

### 6.1 Tool 标识约定

工具标识必须在文档层先收敛，否则后面的 catalog、prompt、installer、audit 都会不稳定。

统一约定三层标识：

1. `toolId`
   - 全局唯一主键
   - 用于 catalog、registry、audit、install、API、executor 路由
   - 不直接面向最终用户
2. `toolName`
   - LLM 在本轮调用时看到的 function name
   - 必须在“当前注入 shortlist”内唯一
   - 可在需要时加前缀消歧
3. `displayName`
   - 纯 UI 展示名称
   - 不参与执行路由

建议规则：

```text
toolId      = global stable id
toolName    = per-turn callable name
displayName = human-facing label
```

推荐示例：

```text
toolId:      builtin:file_io
toolName:    file_io
displayName: 文件读写

toolId:      mcp:notion.search
toolName:    notion_search
displayName: Notion Search

toolId:      cli:opencli.browser_search
toolName:    browser_search
displayName: 浏览器搜索
```

必须明确：

- executor 只认 `toolId`
- UI 只依赖 `displayName`
- LLM 调用层使用 `toolName`
- `toolName` 到 `toolId` 的映射由本轮 injected shortlist 维护

### 6.2 ToolCatalogEntry

```ts
type ToolSourceType = 'builtin' | 'mcp' | 'cli'
type ToolRiskLevel = 'low' | 'medium' | 'high'

interface ToolCatalogEntry {
  toolId: string
  sourceType: ToolSourceType
  providerId: string | null
  toolName: string
  displayName: string
  description: string
  summary: string
  tags: string[]
  aliases: string[]
  parametersSchema: Record<string, unknown>
  requiredParams: string[]
  examples: Array<{
    intent: string
    args: Record<string, unknown>
  }>
  capabilities: {
    readsWeb: boolean
    writesFiles: boolean
    readsFiles: boolean
    executesCode: boolean
    needsBrowser: boolean
    needsNetwork: boolean
    needsAuth: boolean
    supportsJsonOutput: boolean
  }
  constraints: {
    riskLevel: ToolRiskLevel
    approvalRequired: boolean
    timeoutSeconds: number | null
  }
  retrieval: {
    keywords: string[]
    embeddingText: string
  }
  availability: {
    enabled: boolean
    healthy: boolean
    reason?: string
  }
}
```

补充约束：

- `toolId` 必须全局唯一
- `toolName` 只要求在当前 shortlist 内唯一
- 不允许再把 `displayName` 当作路由键或 function name

### 6.3 `embeddingText` 生成规范

`embeddingText` 不能由各个 provider 自由拼接，必须统一生成。

建议统一模板：

```text
toolName
summary
description
aliases
tags
capabilities
```

其中：

- `toolName`
  - 当前工具的 callable name
- `summary`
  - 一句话摘要
- `description`
  - 完整说明
- `aliases`
  - 常见别名、同义词
- `tags`
  - 领域标签
- `capabilities`
  - 如 `browser`, `auth`, `file_write`, `json_output`

生成规则：

1. 由统一 catalog builder 生成，而不是由 builtin/mcp/cli provider 各自生成
2. 不将动态状态字段直接拼入 `embeddingText`
   - 如当前健康状态、连接状态、最近错误
3. 允许将稳定能力标签拼入
   - 如 `needs_browser`
   - `needs_auth`
   - `supports_json_output`

这样可以保证：

- 不同来源的向量质量一致
- 检索信号稳定
- 不因短期运行态变化污染 embedding

### 6.2 设计说明

关键点：

1. `sourceType` 明确来源，不再靠名称猜测。
2. `providerId` 区分：
   - `builtin` 可为 `runtime`
   - `mcp` 可为 server id
   - `cli` 可为 `opencli` / `local-harness` / `cli-anything`
3. `summary` 用于轻量卡片注入。
4. `parametersSchema` 仅在 shortlist 阶段注入。
5. `capabilities` 和 `constraints` 用于过滤和重排，而不是只靠语义检索。

## 7. Skill 的新角色

本设计要求明确弱化 skill 的执行地位。

### 7.1 Skill 应该承担的职责

- 安装与版本管理
- 本地目录结构
- `SKILL.md`
- 示例、脚本、策略默认值
- 包含一个或多个 tool manifests

### 7.2 Skill 不该承担的职责

- 作为全量工具 schema 的直接注入对象
- 作为默认执行入口
- 与 builtin/mcp/cli 并列成为同级执行抽象

### 7.3 一个 skill 产出多个 tools

例如：

```text
skills/opencli-browser/
├── SKILL.md
├── cli-tools/
│   ├── browser_search.json
│   ├── browser_extract.json
│   └── browser_click_path.json
└── policy.json
```

这比“一个 skill 直接等于一个 tool”更适合复杂能力包。

## 8. 三类工具的接入设计

### 8.1 Builtin Tool Provider

来源：

- runtime 内建 registry

当前对应：

- [bootstrap.py](/Users/yanghuaiyuan/AI/semibot/runtime/src/skills/bootstrap.py)

接入方式：

1. 启动时遍历 `registry.list_tools()`
2. 提取 `toolName / description / parameters`
3. 结合静态 metadata 生成 `ToolCatalogEntry`

额外建议：

- 为 builtin tools 增加一份集中 metadata 定义文件
- 不要只依赖 tool 类本身的 description

### 8.2 MCP Tool Provider

来源：

- 已连接 MCP servers 的动态 tools

当前对应：

- [capability.py](/Users/yanghuaiyuan/AI/semibot/runtime/src/orchestrator/capability.py)
- [semigraph_adapter.py](/Users/yanghuaiyuan/AI/semibot/runtime/src/session/semigraph_adapter.py)

接入方式：

1. session 建立 MCP 连接
2. 拉取每个 server 的工具清单
3. 展平成统一 catalog entry
4. 记录：
   - `providerId = mcp_server_id`
   - `healthy`
   - `needsAuth`
   - `reason`

### 8.3 CLI Tool Provider

来源：

- OpenCLI adapters
- CLI-Anything 生成的 harness
- 手工注册本地 CLI 工具

CLI tool 必须 manifest 化，不允许裸命令。

建议 manifest：

```json
{
  "tool_id": "opencli.browser.search",
  "source_type": "cli",
  "provider_id": "opencli",
  "tool_name": "browser_search",
  "description": "Search the web through an authenticated browser session",
  "command": ["opencli", "browser", "search"],
  "json_mode": true,
  "output_schema": {
    "type": "object",
    "properties": {
      "ok": { "type": "boolean" },
      "data": {},
      "error": {}
    },
    "required": ["ok"]
  },
  "stderr_policy": "log_only",
  "nonzero_exit_policy": "error",
  "timeout_seconds": 60,
  "parameters": {
    "type": "object",
    "properties": {
      "query": { "type": "string" }
    },
    "required": ["query"]
  },
  "risk_level": "medium",
  "needs_browser": true,
  "needs_auth": true
}
```

其中最小输出契约建议统一为：

```json
{
  "ok": true,
  "data": {},
  "error": null
}
```

说明：

- `json_mode: true` 仅表示 CLI 应输出 JSON，不足以保证可解析性
- `output_schema` 用于约束 stdout JSON 结构
- executor 不应依赖自由格式 stdout

#### 8.3.1 CLI 执行层契约

`cli_tool_provider` 必须遵守统一执行约束：

1. 只使用 argv 执行，不走 shell 拼接
2. 超时后强制终止进程，并返回 timeout 错误
3. 默认以 `exit code` 判定成功或失败
4. `stderr` 默认只记录日志，不单独构成失败
5. 非零退出码应映射为标准 `ToolResult.error`
6. 若 `json_mode=true`，stdout 必须可解析并通过 `output_schema` 校验

建议的默认规则：

- timeout:
  - 到达 `timeout_seconds` 后先发送 terminate
  - 短暂等待后强制 kill
- stderr:
  - 默认 `log_only`
  - 如 manifest 明确声明，可升级为 `error_if_nonempty`
- exit code:
  - `0` 视为成功
  - 非 `0` 视为失败，进入 `ToolResult.error`

建议的错误映射：

```json
{
  "ok": false,
  "error": {
    "code": "CLI_EXIT_NONZERO",
    "message": "CLI exited with code 2",
    "details": {
      "exitCode": 2,
      "stderrTail": "..."
    }
  }
}
```

### 8.4 为什么 CLI 不等于 shell

因为 shell 命令不可治理：

- schema 不稳定
- approval 粒度过粗
- 难做健康检查
- 风险不可控

CLI tool 必须满足：

- argv 执行，不走 shell 拼接
- 有参数 schema
- 有 stdout/stderr contract
- 最好支持 `--json`
- 有健康与风险元数据

## 9. Tool Catalog 与 Schema Store 分离

为了解决 schema 太多的问题，必须把“目录”和“完整 schema”分开。

### 9.1 Tool Catalog Card

给 planner 看的轻量卡片，尽量小。

```json
{
  "toolName": "web_fetch",
  "source": "builtin",
  "summary": "Fetch and parse public web pages",
  "tags": ["http", "web", "content"],
  "risk": "low",
  "needs_auth": false,
  "needs_browser": false,
  "writes_files": false
}
```

### 9.2 Full Schema

只给 shortlist 注入，包含：

- 完整 parameters
- required
- examples
- constraints

### 9.3 核心原则

- catalog card 用于 reasoning
- full schema 用于 execution

不要反过来。

## 10. 检索与注入流程

### 10.1 总流程

```text
User Request
  -> Core Tools Always-On
  -> Metadata Filter
  -> Lexical Retrieval
  -> Simple Rerank
  -> Top-K Full Schema Injection
  -> LLM Tool Call
  -> Executor
```

### 10.2 第一阶段：核心工具常驻

不需要每次检索的工具应常驻注入。

建议默认常驻：

- `file_io`
- `search`
- `web_fetch`
- `memory`
- `code_executor`

原因：

- 高频
- 低歧义
- 基础设施属性强

### 10.3 第二阶段：Metadata Filter

先做硬过滤，不做权重向量。

过滤条件：

- 未连接 MCP 工具剔除
- 未安装 CLI 工具剔除
- 当前环境缺失必要 binary 的工具剔除
- 当前任务明显不需要的高风险工具降权

### 10.4 第三阶段：Lexical Retrieval

MVP 先只做词法召回。

依据：

- `toolName`
- aliases
- tags
- keywords

### 10.5 第四阶段：Simple Rerank

MVP 只做简单重排：

- installability
- trust level
- risk level
- dependency count

### 10.6 第五阶段：注入 full schema

最终建议：

- 常驻核心工具 4 到 6 个
- 动态候选 5 到 8 个
- 总 full schema 控制在 10 到 14 个

不要超过这个量级，除非明确进入二次扩召。

## 11. 为什么 MVP 不先做向量检索

MVP 不先做向量检索，原因有三：

1. 工具选择首先是 metadata 和 lexical 问题
2. 当前没有足够数据支撑 embedding 排序收益
3. 引入 embedding 会把实现复杂度显著抬高

因此 MVP 先采用：

- metadata filter
- lexical retrieval
- simple rerank

后续阶段再评估是否引入 embedding。

## 12. 二次扩召与失败恢复

第一次 shortlist 失败后，系统不应让 LLM盲试。

### 12.1 参数校验失败

处理：

- 保留当前候选类别
- 扩大候选 top-K
- 重新注入更具体的同类工具 schema

### 12.2 执行失败

根据失败类型做不同 fallback：

- auth failure -> 优先换同类已认证工具
- connectivity failure -> 优先 builtin fallback
- capability mismatch -> 扩大召回范围

### 12.3 无匹配

允许 planner 输出：

- `no_suitable_tool`

然后：

- 纯文本回答
- 或建议安装 skill / 连接 MCP / 安装 CLI harness

## 13. 对现有代码的改造点

### 13.1 新增模块

建议新增：

- `runtime/src/orchestrator/tool_catalog.py`
- `runtime/src/orchestrator/tool_retrieval.py`
- `runtime/src/orchestrator/tool_router.py`
- `runtime/src/orchestrator/cli_tool_provider.py`

### 13.2 现有模块调整

#### `semigraph_adapter.py`

当前：

- 直接构建 `available_tools`
- 直接构建 `available_mcp_servers`

建议：

- 改为先构建 unified tool catalog
- 再根据当前 step 动态生成 `selected_tool_schemas`

#### `capability.py`

当前已有：

- `ToolCapability`
- `McpCapability`
- `SkillCapability`

建议：

- 不新增 `CliCapability`
- 直接将 CLI 来源能力归一到 `ToolCatalogEntry`

补充约束：

- planner 不应直接基于 capability subtype 做独立决策分支
- 所有来源能力都必须先归一到 `ToolCatalogEntry`
- executor 再根据 `toolId/sourceType` 路由到 builtin / mcp / cli 执行器

#### `skills/bootstrap.py`

建议只负责 builtin registry bootstrap，不再承担“如何把全部能力直接暴露给 LLM”的职责。

## 14. Prompt 注入策略

### 14.1 Planner Prompt

Planner 不看 full schema，只看：

- 核心工具卡片
- 动态候选工具卡片
- skill 摘要

推荐结构：

```xml
<tool_catalog>
  <tool id="builtin:file_io" name="file_io" source="builtin" risk="low">Read and write local workspace files.</tool>
  <tool id="cli:opencli.browser_search" name="browser_search" source="cli" risk="medium" needs_browser="true">Search the web through authenticated browser session.</tool>
</tool_catalog>
```

### 14.2 Act Prompt

Act 阶段才拿 full schema。

推荐结构：

- OpenAI tool calling `tools=[...]`
- 外加很短的选择提示：
  - 优先使用已注入候选工具
  - 不要假设未注入工具可用

迁移约束：

- 在 Phase 1 并存期，prompt 注入只能走一条路径
- 不允许旧 `available_tools` 全量注入与新 shortlist schema 注入同时存在
- 旧路径可以继续产出内部数据，但不得再次直接进入 prompt

## 15. Web UI 与治理面

这一章属于后续治理层设计，不是 Phase 1 实现前提。

在当前实施顺序中，前端治理面最后再改。

建议后续新增统一的“工具中心”页面，作为执行能力治理的总入口。

页面定位：

- 页面名称：`工具中心`
- 路由建议：`/tools`
- 目标：统一查看与管理三类工具来源，而不是让用户在 `/tools`、`/mcp`、`/skills` 三个页面之间自行拼接心智模型

### 15.1 顶部结构

页面顶部建议包含：

- 标题：`工具中心`
- 简短副标题：说明该页统一管理 `内建工具 / MCP 服务器 / CLI 工具`
- 顶部 tab 切换

tab 固定为三个：

- `内建工具`
- `MCP 服务器`
- `CLI 工具`

这里的 tab 是信息架构上的一级切面，不是简单的视觉分组。

### 15.2 Tab 1：内建工具

这个 tab 用于展示 runtime 内直接注册的 builtin tools。

目标：

- 查看当前启用状态
- 配置风险级别、审批策略、执行参数
- 识别哪些 builtin tool 是核心基础设施

建议字段：

- toolName
- summary
- enabled / disabled
- risk level
- approval required
- timeout / retry
- source=`builtin`

建议操作：

- 查看 schema
- 编辑参数
- 测试调用

不建议：

- 在此 tab 做新增/删除 builtin tool

### 15.3 Tab 2：MCP 服务器

这个 tab 以“server”为主对象，而不是以单个 tool 为主对象。

目标：

- 管理 MCP server 的连接与认证
- 查看 server 暴露的工具和资源
- 观察连接健康状态

建议字段：

- serverName
- transport
- endpoint
- auth state
- connection status
- exposed tools count
- exposed resources count

建议操作：

- 添加 server
- 编辑 server
- 测试并同步
- 删除 server
- 展开查看其 tools/resources

注意：

- 这个 tab 关注的是“工具来源节点”，不是最终 shortlist 注入结果
- 它是治理面，不是 planner 视图

### 15.4 Tab 3：CLI 工具

这个 tab 用于展示本地 CLI harness 和通过 skill package 导入的 CLI tool。

目标：

- 统一管理“可执行的本地工具能力”
- 让用户理解 skill package / CLI harness / tool source 的关系

建议字段：

- package / toolName
- source=`cli`
- provider，例如 `opencli`、`local-harness`、`cli-anything`
- installed / enabled / invalid
- json-mode support
- auth / browser requirements
- last synced / last indexed

建议操作：

- 安装 skill package / harness
- 启用/停用
- 删除/卸载
- 查看导出的 tools
- 重新索引 / 刷新 runtime

说明：

- 这一层面向的是“工具来源管理”
- 不要求第一页就展示所有 tool schema 细节

### 15.5 页面层级与卡片模型

页面建议采用两层展示：

1. 列表层
   - 先看来源对象或工具对象的摘要卡片
2. 详情层
   - 点击后侧边抽屉或 modal 展示 schema、policy、health、examples

这样做的原因：

- 避免首页信息密度过高
- 与“catalog card / full schema”分层设计保持一致
- 减少前端页面本身的视觉膨胀

### 15.6 与检索注入体系的对应关系

前端的三个 tab 不是给 LLM 用的分类 UI，而是给人看的治理入口。

二者关系如下：

- Web UI 展示三类来源
- Runtime 内部将三类来源统一汇总为 `ToolCatalogEntry`
- Planner 只看工具目录卡片
- Act 阶段只拿 shortlist full schema

也就是说：

- UI 是 source-oriented
- LLM injection 是 retrieval-oriented

两者不能混为一谈。

### 15.7 页面文案建议

建议页面标题与 tab 文案直接采用下面这套：

- 页面标题：`工具中心`
- 副标题：`统一管理执行能力，按来源分为内建工具、MCP 服务器和 CLI 工具。`
- Tab 1：`内建工具`
- Tab 2：`MCP 服务器`
- Tab 3：`CLI 工具`

### 15.8 当前阶段的实现边界

本设计文档阶段仅确认页面信息架构，不要求立刻重构全部前端页面。

建议的落地顺序：

1. 先在 `/tools` 上增加三 tab 壳层
2. 复用现有 `/tools`、`/mcp`、`/skills` 页面主体作为三个面板
3. 再逐步统一：
   - 视觉风格
   - 空态
   - 错误态
   - schema/detail drawer
4. 最后再引入基于 unified tool catalog 的真实数据驱动页面

最终目标不是做一个“新页面皮肤”，而是做一个和运行时工具目录模型一致的治理面。

## 16. 模块边界与目录结构

这一章定义 Runtime / API / Web 的责任边界，避免把能力发现、安装、执行、治理全部揉在一个层里。

### 16.1 责任分层

建议按下面三层拆分：

1. Runtime
   - 统一工具目录
   - 工具检索
   - 工具执行
   - 缺失能力最小解析闭环
2. API
   - 把 Runtime 能力暴露为稳定的本地 HTTP 接口
   - 提供 Web 所需的治理与安装入口
   - 做认证、限流、返回格式整理
3. Web
   - 工具中心治理面
   - 缺失能力推荐与审批交互
   - 状态展示，不承担真实执行逻辑

一句话：

- Runtime 负责真相
- API 负责边界
- Web 负责交互

### 16.2 Runtime 模块建议

建议新增或明确这些模块：

```text
runtime/src/orchestrator/
  tool_catalog.py
  tool_retrieval.py
  tool_router.py
  cli_tool_provider.py
  mcp_tool_provider.py
  builtin_tool_provider.py
  missing_capability.py

runtime/src/skills/
  skill_registry.py        # Post-MVP
  skill_installer.py      # Post-MVP

runtime/src/tools/
  tool_registry.py
  tool_installer.py       # Post-MVP
```

职责建议如下。

#### `tool_catalog.py`

负责：

- 聚合 builtin / mcp / cli 三类来源
- 生成统一 `ToolCatalogEntry`
- 暴露查询接口

不负责：

- 安装
- 执行
- Web/API 返回格式

#### `tool_retrieval.py`

负责：

- lexical 检索
- embedding 检索
- metadata filter
- hybrid rerank
- shortlist 生成

不负责：

- 实际执行 tool
- UI 文案拼装

#### `tool_router.py`

负责：

- 接收 act 阶段选中的 tool id
- 分发到 builtin / mcp / cli executor

不负责：

- 做安装决策
- 做 registry 检索

#### `missing_capability.py`

负责：

- 识别当前 shortlist 不足
- 查询 tool registry
- 读取最小 skill 索引信息（如有）
- 生成推荐候选
- 驱动最小 `recommend -> install -> retry` 闭环

不负责：

- 直接渲染前端
- 直接承担 Web approval UI

#### `tool_installer.py`

该模块属于 Post-MVP 能力。

负责：

- 安装独立 tool，优先面向 cli tools
- schema 校验
- health check
- catalog refresh trigger

#### `skill_installer.py`

该模块属于 Post-MVP 能力。

负责：

- 安装 skill package
- 校验 skill manifest
- 安装 `bundledTools`
- 校验依赖

### 16.3 API 边界

API 应作为 Runtime 能力的治理接口，不应重新实现核心编排逻辑。

建议 API 只做：

- request validation
- auth / rate limit
- 调 Runtime service
- 标准化 response

不应在 API 内部复制：

- 检索算法
- 安装状态机
- tool catalog 聚合逻辑

建议的 API 分组：

```text
/v1/tools/*
/v1/mcp/*
/v1/skills/*
/v1/capabilities/*
```

其中：

#### `/v1/tools/*`

面向最终可执行工具：

- `GET /v1/tools/catalog`
- `POST /v1/tools/install`
- `POST /v1/tools/reindex`
- `POST /v1/tools/doctor`

#### `/v1/skills/*`

面向能力包：

- `GET /v1/skills`
- `POST /v1/skills/install`
- `POST /v1/skills/validate`

#### `/v1/capabilities/*`

面向缺失能力解析与推荐：

- MVP:
  - `POST /v1/capabilities/install`
- 后续阶段再拆分更细的治理接口

### 16.4 Web 边界

Web 不应承担真正的安装和编排逻辑。

Web 负责：

- 展示 unified capability governance UI
- 发起安装请求
- 展示推荐候选
- 展示最小 install / retry 状态
- 展示 tool / skill / mcp 的治理信息

Web 不负责：

- 本地直接执行 installer
- 自己实现检索逻辑
- 自己决定最终安装候选

Web 应始终通过 API 操作 Runtime。

### 16.5 前端路由建议

建议保留以人为中心的路由，而不是把内部模块名直接暴露给用户。

推荐：

- `/tools`
  - 工具中心
- `/skills`
  - 能力包与安装源
- `/mcp`
  - MCP 连接管理

后续如果统一入口足够成熟，`/skills` 和 `/mcp` 可以退居二级页面，但第一阶段无需硬删。

### 16.6 数据流

建议的数据流如下：

```text
Web UI
  -> API request
  -> Runtime service
  -> tool registry + catalog
  -> state update
  -> API response
  -> Web status refresh
```

而在任务执行路径上：

```text
User task
  -> Runtime planner
  -> tool_retrieval shortlist
  -> act phase tool call
  -> if missing capability:
       missing_capability resolver
       -> registry search
       -> install
       -> catalog refresh
       -> retry
```

### 16.7 模块边界结论

这套设计的边界应固定为：

- Runtime 管核心能力模型和状态机
- API 管安全边界与本地控制接口
- Web 管治理面与审批交互

只要这个边界不被打破，后面扩展更多 tool source 或 registry 也不会把系统重新搅混。

## 17. Prompt 与 API 契约补充

这一章补充两类直接影响实现的契约。

其中：

- MVP 只需要 `install` 单入口
- 更细的审批与状态接口属于后续强化

### 17.1 Planner Prompt 注入样例

Planner 阶段只应看到：

- 当前任务上下文
- 核心工具卡片
- 动态候选工具卡片
- 必要的 skill 摘要

不应看到 full schema。

推荐格式：

```xml
<tool_catalog>
  <tool id="builtin:file_io" name="file_io" source="builtin" risk="low" approval="none">
    Read and write local workspace files.
  </tool>
  <tool id="builtin:web_fetch" name="web_fetch" source="builtin" risk="low" approval="none">
    Fetch and parse public web pages.
  </tool>
  <tool id="cli:opencli.browser_search" name="browser_search" source="cli" risk="medium" approval="required" needs_browser="true">
    Search the web through an authenticated browser session.
  </tool>
  <tool id="mcp:notion.query" name="notion_query" source="mcp" risk="medium" approval="required" requires_auth="true">
    Query content from a connected Notion MCP server.
  </tool>
</tool_catalog>

<skill_summaries>
  <skill id="opencli-browser">
    Provides browser-oriented CLI tools such as browser_search and browser_extract.
  </skill>
</skill_summaries>
```

Planner 提示中应增加一条硬规则：

- 如果当前候选工具不足以完成任务，输出 `missing_capability`，不要假设未注入工具可用

### 17.2 Act Prompt 注入样例

Act 阶段只拿 shortlist full schema。

推荐结构：

- OpenAI tool calling `tools=[...]`
- 额外系统提示：
  - 只可调用已注入工具
  - 若能力不足，返回 `missing_capability`

建议附加一个最小控制块：

```xml
<tool_execution_policy>
  <rule>Only call tools present in this turn's tool schema list.</rule>
  <rule>If required capability is missing, emit missing_capability instead of improvising.</rule>
  <rule>Prefer low-risk tools when they can satisfy the task.</rule>
</tool_execution_policy>
```

### 17.2.1 `missing_capability` 结构化契约

`missing_capability` 不能只是自由文本标签，必须定义成结构化输出协议。

建议统一最小契约：

```json
{
  "type": "missing_capability",
  "version": "1",
  "intent": "authenticated_browser_search",
  "reason": "Current shortlisted tools cannot operate an authenticated browser session.",
  "requiredCapabilities": ["browser", "authenticated_session"],
  "preferredSources": ["cli", "mcp"]
}
```

约束如下：

- planner 可以输出该对象
- act 阶段也可以在执行前返回该对象
- resolver 只接收结构化 `missing_capability`，不依赖自由文本解析

最小必填字段：

- `type`
- `version`
- `intent`
- `reason`

推荐字段：

- `requiredCapabilities`
- `preferredSources`

### 17.2.2 Planner / Act 的统一约束

无论是 planner 还是 act，只要发现当前 shortlist 无法满足任务，都应输出同一结构化 `missing_capability` 对象。

这意味着：

- planner 不输出模糊文字，例如 “maybe need browser tool”
- act 不输出仅供人阅读的标签，例如 `missing_capability: browser`
- 后续 resolver / API / 审计都以统一 JSON 契约为准

### 17.3 MVP 单入口 API

MVP 建议先只定义一个主入口：

- `POST /v1/capabilities/install`

请求示例：

```json
{
  "taskId": "tsk_123",
  "sessionId": "sess_456",
  "taskText": "登录浏览器并搜索最新的 AI 行业动态",
  "currentShortlistToolIds": ["file_io", "web_fetch", "memory"],
  "missingCapability": {
    "type": "missing_capability",
    "intent": "authenticated_browser_search",
    "reason": "Current shortlisted tools cannot operate an authenticated browser session.",
    "requiredCapabilities": ["browser", "authenticated_session"],
    "preferredSources": ["cli", "mcp"]
  }
}
```

响应示例：

```json
{
  "ok": true,
  "data": {
    "resolutionMode": "recommend",
    "recommendedTools": [
      {
        "toolId": "opencli.browser_search",
        "sourceType": "cli",
        "riskLevel": "low",
        "trustLevel": "official"
      }
    ],
    "recommendedSkills": [],
    "nextAction": "manual_install_required"
  }
}
```

### 17.4 后续分拆接口（Post-MVP）

当后续需要异步安装、审批治理、状态轮询时，再拆分：

- `POST /v1/capabilities/resolve-missing`
- `POST /v1/capabilities/approve-install`
- `GET /v1/capabilities/install-status/:installRequestId`
- `POST /v1/capabilities/retry-task`

## 18. 风险分级与审批矩阵

缺失能力解析和工具安装必须绑定风险模型，否则自动推荐会快速滑向不可控。

### 18.1 风险等级

建议统一使用三档：

- `low`
- `medium`
- `high`

#### `low`

典型特征：

- 只读
- 无外部认证
- 无文件写入
- 无系统状态变更

例如：

- 公开网页抓取
- 文本处理
- 只读搜索

#### `medium`

典型特征：

- 需要登录态
- 需要外部连接
- 有限文件写入
- 影响局部工作区状态

例如：

- 认证浏览器搜索
- 带凭据的 SaaS 查询
- 本地 CLI 生成产物到工作区

#### `high`

典型特征：

- 修改系统环境
- 高权限本地执行
- 外部发布或 destructive actions
- 涉及 secrets 注入或服务连接变更

例如：

- 安装新的系统级 binary
- 修改全局配置
- 接入新的外部 MCP server 并写入认证信息

### 18.2 审批矩阵

建议的默认矩阵如下：

| 场景 | low | medium | high |
|---|---|---|---|
| Tool 调用 | 自动允许 | 需要审批或策略允许 | 必须审批 |
| Tool 安装 | 仅在满足全部自动安装条件时可自动，否则审批 | 默认审批 | 必须审批 |
| Skill 安装 | 默认审批 | 默认审批 | 必须审批 |
| MCP server 新连接 | 不适用 | 默认审批 | 必须审批 |

### 18.3 自动安装允许条件

只有同时满足这些条件，才允许自动安装：

1. 候选来自官方或 allowlist 发布者
2. 风险等级为 `low`
3. 不要求新增 secrets
4. 不要求新增 MCP 连接
5. 不修改系统级环境
6. 失败可原子回滚

### 18.4 Web 治理面展示要求

Web 在推荐安装候选时，应至少展示：

- 风险等级
- 来源可信度
- 安装后新增哪些 tools
- 依赖哪些外部条件
- 是否会请求新的认证或系统 binary

如果用户看不到这些信息，审批就只是形式化按钮，不具备真实治理意义。

## 19. 存储模型与审计

完整设计落地后，不能只靠内存状态。

但对 MVP 来说，只需要最小持久化来支撑：

- tool catalog cache
- 最小 install/retry 过程状态

完整形态下至少需要一层轻量持久化来支撑：

- catalog cache
- registry entries
- install request
- approval / audit metadata

### 19.1 存储原则

建议采用以下原则：

1. `tool catalog` 可重建，但需要缓存
2. `registry entry` 是事实来源的一部分，应可持久化
3. `install request` 在 MVP 应持久化；`approval / audit` 在完整治理阶段应可持久化
4. 检索 embedding 可以延后，不作为 V1 的阻塞项

### 19.2 建议的持久化对象

#### 19.2.1 Tool Catalog Cache

用于缓存运行时聚合结果，避免每次都全量重建。

建议字段：

```ts
interface ToolCatalogCacheRecord {
  toolId: string
  sourceType: 'builtin' | 'mcp' | 'cli'
  providerId: string | null
  packageId?: string | null
  versionHash: string
  enabled: boolean
  healthy: boolean
  lastIndexedAt: string
  summaryJson: object
}
```

说明：

- 这是 cache，不是唯一真相
- 可以丢失后重建
- 适合存 SQLite

#### 19.2.2 Tool Registry Entry

用于记录可安装 tool 的 registry 元数据。

建议字段：

```ts
interface ToolRegistryRecord {
  toolId: string
  sourceType: 'builtin' | 'mcp' | 'cli'
  publisherId: string
  trusted: boolean
  official: boolean
  installPath: 'none' | 'tool_installer' | 'skill_installer'
  manifestJson: object
  updatedAt: string
}
```

#### 19.2.3 Skill 索引记录（可选）

MVP 不要求单独建表。

若后续需要持久化 skill 元数据，可再拆分独立记录。

#### 19.2.4 Install Request

用于记录一次能力安装请求的生命周期。

建议字段：

```ts
interface InstallRequestRecord {
  installRequestId: string
  taskId?: string | null
  sessionId?: string | null
  targetType: 'tool' | 'skill'
  targetId: string
  approvalMode: 'user_confirmed' | 'policy_auto' | 'denied'
  state:
    | 'queued'
    | 'awaiting_approval'
    | 'installing'
    | 'refreshing_catalog'
    | 'retrying_task'
    | 'completed'
    | 'failed'
    | 'cancelled'
  errorText?: string | null
  createdAt: string
  updatedAt: string
}
```

#### 19.2.5 Approval / Audit Metadata（MVP 内嵌）

MVP 不单独建：

- `ApprovalDecisionRecord`
- `CapabilityAuditEventRecord`

而是直接内嵌到 `InstallRequestRecord` 的 JSON 字段中。

例如：

```ts
interface InstallRequestRecord {
  installRequestId: string
  taskId?: string | null
  sessionId?: string | null
  targetType: 'tool' | 'skill'
  targetId: string
  approvalMode: 'user_confirmed' | 'policy_auto' | 'denied'
  state: string
  metadataJson?: {
    approval?: object
    auditTrail?: object[]
  }
  errorText?: string | null
  createdAt: string
  updatedAt: string
}
```

等真正有查询需求时，再拆成独立表。

#### 19.2.6 Usage Prior（非 MVP）

`usage_prior_score` 对检索质量有帮助，但不属于 MVP 必做项。

因此：

- MVP 阶段不持久化 usage prior
- `usage_prior_score` 在 MVP 中固定为 `0`

若后续启用，建议新增：

```ts
interface ToolUsageStatRecord {
  toolId: string
  sessionId?: string | null
  agentId?: string | null
  successCount: number
  failureCount: number
  lastUsedAt?: string | null
}
```

并仅在后续阶段启用其检索权重。

### 19.3 存储位置建议

V1 建议直接落在现有本地 SQLite 中。

原因：

- 当前是单用户系统
- 本地事务和审计查询都够用
- 不引入额外运维复杂度

推荐原则：

- catalog cache：SQLite
- registry snapshot：SQLite + 文件系统 manifest
- install artifacts：文件系统
- audit / approval / install request：SQLite

### 19.4 文件系统与数据库的边界

建议明确：

- 文件系统保存：
  - skill package 内容
  - cli tool manifests
  - installer 产物
  - OpenCLI / harness 实际文件
- SQLite 保存：
  - 元数据
  - 状态机状态
  - approval / audit / install request
  - cache

也就是说：

- 文件系统存“资产”
- 数据库存“状态”

### 19.5 Installer 原子性保证

`tool_installer` 和 `skill_installer` 都必须提供原子失败语义。

建议统一采用：

1. 先写入 staging 目录
2. 做 manifest/schema/health 校验
3. 校验通过后再更新 catalog / registry 记录
4. 全部成功后再将 install request 标记为 completed

失败时：

- 删除 staging 目录
- 不写入最终 catalog 记录
- 不更新 active/installable 状态
- install request 标记为 failed

也就是说：

- 文件系统资产和 catalog 状态要么一起成功
- 要么一起不生效

对于 skill 安装：

- 先完成 skill package staging
- 再对子内 `bundledTools` 调用 `tool_installer`
- 任一子步骤失败，整个 skill install 失败且不应留下半安装态

## 20. 迁移路径

这套模型不能一次性硬切。应按兼容迁移推进。

### 20.1 迁移原则

1. 先兼容当前 builtin + mcp + skill 结构
2. 先建 unified catalog，不立刻重写全部 UI
3. 先让新目录模型与旧能力模型并存
4. 先把 skill 从“执行入口”降级为“包层”，再逐步减少旧耦合

### 20.2 Phase 0：只做兼容索引

目标：

- 不改变现有用户行为
- 只增加 unified tool catalog 与 registry cache

做法：

- builtin tools 继续从现有 registry 注册
- MCP tools 继续从现有连接同步
- skill 先只作为 package metadata，被索引但不改变执行链

结果：

- 先得到统一 catalog
- 不要求前端和 planner 立刻切流

### 20.3 Phase 1：切换注入模型

目标：

- 从“直接全量构建 available_tools”转向：
  - catalog card
  - shortlist full schema

做法：

- `semigraph_adapter` 先从 unified catalog 取数据
- planner prompt 改为只注入卡片
- act 阶段只注入 shortlist schema

这一步是整个架构改造的核心拐点。

### 20.4 Phase 2：补齐 installer 体系

目标：

- 引入 `tool_installer`
- 保留 `skill_installer`

做法：

- 先支持独立 CLI tool 安装
- skill 安装时改为内部调用 `tool_installer` 处理 `bundledTools`
- 安装请求和 approval 开始写入持久化表

### 20.5 Phase 3：引入缺失能力解析

目标：

- 让任务执行在缺工具时进入 `recommend -> approve -> install -> retry`

做法：

- 先做 `recommend` 模式
- 不默认自动安装
- Web 只做推荐和审批治理面

### 20.6 Phase 4：前端统一治理面

目标：

- 完成 `/tools` 作为统一工具中心
- `/skills` 和 `/mcp` 逐步退为二级治理页

做法：

- 先复用旧页面主体
- 再接 unified tool catalog 真数据

### 20.7 迁移完成标志

当满足以下条件时，可认为迁移基本完成：

1. Planner 不再依赖全量 schema 注入
2. `skill` 不再作为主要执行原语参与注入
3. 所有可执行能力都能统一进入 `ToolCatalogEntry`
4. CLI tools 可以独立安装，不必强绑 skill
5. 缺失能力解析具备推荐、审批、安装、重试闭环

### 20.8 迁移结论

迁移不应理解为“删除旧系统”，而应理解为：

- 先加统一目录
- 再切换注入模型
- 再切 installer 和缺失能力解析
- 最后统一治理面

只要顺序正确，这次重构可以在不断现有产品主路径的情况下逐步落地。

## 21. MVP 范围

为了降低改造风险，V1 不应试图一次性交付完整生态。

MVP 的目标应是：

- 不改变现有用户主路径的稳定性
- 先把执行层抽象收拢
- 先让 schema 注入和缺失能力解析具备最小闭环

### 21.1 MVP 必做

MVP 建议只做这些：

1. 建 unified tool catalog
   - 聚合 builtin + mcp
   - 为 cli 预留 source type，但第一阶段可不接真实 provider
2. 建 `ToolCatalogEntry`
   - 替换散落的 tool/mcp 汇总方式
3. 切换注入模型
   - planner 看 card
   - act 看 shortlist full schema
4. 建最小 `tool registry` / `skill registry` 结构
   - `tool registry` 最小可用
   - skill 只保留静态索引信息，不做完整 registry
5. 建最小 missing capability resolution
   - 只支持 `recommend` 模式
   - 默认人工安装
   - 安装后 refresh + retry
6. Web 只做最小治理面占位
   - 可展示推荐结果与安装状态
   - 不重做整套工具中心 UI

### 21.2 MVP 明确不做

MVP 不做这些：

1. 不做向量数据库
2. 不做默认自动安装
3. 不做 approval/audit 的完整治理状态机
4. 不接特定外部生态作为前置依赖
5. 不重写全部前端页面
6. 不把所有 skill 迁成新格式
7. 不做复杂 usage prior 排序
8. 不做完整企业策略系统

### 21.3 MVP 完成标志

满足以下条件即可认为 MVP 完成：

1. builtin + mcp 已进入统一 catalog
2. planner / act 注入模型已切换
3. 缺失能力时能返回结构化推荐
4. 用户可根据推荐完成人工安装或受控安装
5. 安装完成后可刷新 catalog 并重试

## 22. 实施任务清单

这一章把设计拆成可执行任务，而不是只保留章节级目标。

### 22.1 Runtime 任务

#### R1. 建 unified tool catalog

- 新建 `tool_catalog.py`
- 聚合 builtin tools
- 聚合 mcp tools
- 预留 cli tool 接口
- 输出统一 `ToolCatalogEntry`

#### R2. 建 tool retrieval

- 新建 `tool_retrieval.py`
- 实现 lexical retrieval
- 实现 metadata filter
- 实现最小 hybrid rerank
- 输出 shortlist ids

#### R3. 切换注入模型

- 改 `semigraph_adapter.py`
- planner 注入 card
- act 注入 shortlist full schema
- 缺能力时返回 `missing_capability`

#### R4. 建 missing capability resolver

- 新建 `missing_capability.py`
- 查询 tool registry
- 读取最小 skill 索引信息（如有）
- 输出推荐结果
- 接最小 refresh/retry 闭环

#### R5. 建 installer 边界

- 先定义 installer 边界，不要求 Phase 1 实现完整 installer 体系
- skill 安装暂可保留现有路径
- 后续阶段再引入 `tool_installer.py`

### 22.2 API 任务

#### A1. 暴露 catalog 与 registry 接口

- `GET /v1/tools/catalog`
- `GET /v1/skills`

#### A2. 暴露 missing capability 接口

- MVP:
  - `POST /v1/capabilities/install`
- 后续阶段再拆分 approval/install status 接口

#### A3. 接 auth / rate limit / 审批边界

- 统一认证
- `install` 单入口接口单独限流
- approval 类接口属于后续阶段

### 22.3 Web 任务

#### W1. 最小能力推荐面板

- 在现有任务相关 UI 中展示 missing capability 推荐结果
- 展示推荐 tool / skill
- 展示风险与依赖摘要

#### W2. 安装审批与状态展示

- 属于后续治理阶段
- MVP 只需要展示推荐结果与“如何补能力”的引导

#### W3. 工具中心壳层

- 保留“最后再改前端”的策略
- 先只做文档和数据接口准备
- 真正的 `/tools` 三 tab 治理面放后续阶段

### 22.4 数据与迁移任务

#### D1. 建 SQLite 表

- tool catalog cache
- tool registry
- install request
- approval/audit 先内嵌到 install request
- 其他治理表属于后续阶段

#### D2. 建最小索引刷新

- runtime 启动刷新
- install 后刷新
- MCP 连接变更后刷新

#### D3. 兼容旧数据结构

- 旧 builtin registry 不破坏
- 旧 mcp 连接流程不破坏
- 旧 skill 文件结构先继续兼容

### 22.5 实施顺序建议

建议按这个顺序落地：

1. `R1 -> R2 -> R3`
2. `D1 -> D2`
3. `R4 -> A2`
4. 最后再做 `R5 / A3 / W2 / W3`

原因：

- 先把 runtime 核心抽象收拢
- 再补持久化
- 再开放安装和审批接口
- 最后才改前端治理面

## 23. 迭代计划

### Phase 1

- 引入 unified tool catalog
- 实现 core tools always-on
- 实现 catalog card / full schema 分离
- 保留 builtin + mcp

### Phase 2

- 继续完善 lexical + metadata 检索
- 加 simple rerank
- 加失败后二次扩召

### Phase 3

- 引入 CLI tool provider
- 支持 CLI manifest

### Phase 4

- skill 产出多 tool
- usage prior 与分析

### Phase 5

- Web Capabilities 页
- 诊断与可视化
- 更细的 approval/risk 控制

## 24. 最终决策建议

### 24.1 应采纳

1. 执行层统一成三类来源：
   - `builtin`
   - `mcp`
   - `cli`
2. skill 退回能力包层
3. 引入 unified tool catalog
4. 采用分层检索与按需 schema 注入
5. MVP 先做 metadata + lexical 检索，后续再评估更复杂检索

### 24.2 不建议

1. 把所有 skill 都直接注册成 tool
2. 每轮全量注入全部 schema
3. 把任意 shell 命令当作 cli tool
4. 只做 embedding 检索，不做 metadata / lexical / policy

## 25. 结论

Semibot 的工具层最合理的重构方式，不是继续围绕 `skill` 扩张，而是把执行能力明确统一成：

- 内建工具
- MCP 工具
- CLI 工具

然后通过：

- 统一目录
- 分层检索
- 动态 shortlist
- 按需 schema 注入

来解决 token、误选和可扩展性问题。

这条路线既能保留 Semibot 当前本地优先和能力包系统的优势，也能为未来的 CLI harness、更多 tool source 和治理能力留出清晰边界。
