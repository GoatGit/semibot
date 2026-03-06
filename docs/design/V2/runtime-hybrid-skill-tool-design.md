# 混合型技能编排架构设计设计 (Hybrid Skill-Tool Orchestration)

> **版本: V2 (Proposed)**
> **状态: Draft**

## 1. 背景与核心痛点

当前的技能重构设计 (Runtime Skill Manifest Cache Design) 在缓存复用上做出了重要改进，但其“基于文本推断 CLI 契约”和“强迫 LLM 写 Bash 命令”的本质并未改变。

根据我们对大模型交互特性的分析，存在以下痛点：

1. **幻觉与语法错误**：大语言模型（LLM）擅长输出符合预定义的结构化 JSON，但不擅长处理包含各种引号转义、环境变量拼接的 Shell 命令，容易出现拼写错误。
2. **校验黑盒（死循环）**：当 LLM 生成的伪命令行因为参数不匹配被执行器 (runner) 拦截时，LLM 只能靠文本建议乱猜，容易陷入毫无意义的重试阶段。
3. **上下文极度臃肿 (Context Bloat)**：把所有脚本的用法参数全塞给规划器 (Planner)，导致 Token 热点散乱。

相较于此，开源项目 OpenClaw 等普遍采用 **Tool Calling / Function Calling (函数调用)** 的强类型交互模式，其成功率和执行效率远胜于“纯命令行模式”。

## 2. 设计目标 (Goals)

本设计旨在提出一套兼顾 "**基于文件系统的强可扩展性 (Semibot 特色)**" 与 "**原生结构化 Tool Calling 的高可用性 (业界标准)**" 的混合型技能使用机制。

1. **强类型执行 (JSON Driven)**：全面转向基于 OpenAPI 风格 Schema 的原生大模型 Tool Calling，废弃让 LLM 手写 CLI 命令的模式。
2. **渐进式加载 (Progressive Context)**：保持 Planner (规划) 阶段的清晰，只下发技能简介；在具体的执行阶段再加载强类型 Tool Schema 细节。
3. **保留文件资产特性 (Filesystem as DB)**：仍然支持在 `skills/` 目录下放置 `SKILL.md`、`scripts/`，保证 Agent 能够进化与修改代码的能力。

## 3. 核心对象与架构设计

### 3.1 `Skill` 的文件系统呈现结构

为了支持强类型调用，我们需要在技能文件夹中显式增加一份用来定义工具调用的契约文件（`tools_schema.json` 或 `schema.yaml`）。

```text
skills/deep-research/
├── SKILL.md            # 技能摘要，仅用于给 Planner 提供方向性理解
├── tools_schema.json   # 【新增】以 JSON Schema 形式定义的工具签名列表 (给 LLM Tool Calling)
├── scripts/            # 实际的执行脚本
│   ├── research.py
│   └── validate.py
└── entrypoints.json    # 【新增】定义如何将 Tool Schema JSON 映射到脚本 CLI 参数
```

### 3.2 抽象层：Schema -> CLI 的适配器框架

模型将输出结构化的 JSON args，系统底层将使用 `ToolRunner` 自动地将 JSON 转为实际可执行的安全命令。

#### 3.2.1 `tools_schema.json` 示例

这个文件直供 LLM 并被注入为 `tools` 参数：

```json
[
  {
    "type": "function",
    "function": {
      "name": "deep_research_engine",
      "description": "执行深度网页研究并收集资料",
      "parameters": {
        "type": "object",
        "properties": {
          "query": { "type": "string", "description": "要研究的学术问题" },
          "depth": { "type": "integer", "description": "研究的深度层级 1-3" }
        },
        "required": ["query"]
      }
    }
  }
]
```

#### 3.2.2 `entrypoints.json` 映射示例

这个文件框架用于安全执行：

```json
{
  "deep_research_engine": {
    "command": "python scripts/research.py",
    "args_mapping": {
      "--query": "$.args.query",
      "--depth": "$.args.depth"
    }
  }
}
```

## 4. 编排生命周期 (Orchestration Lifecycle)

新的混合调度机制将整个编排打散为 **发现 -> 规划 -> 下推执行 -> 结构化返回**。

### 阶段 1：全局理解与规划 (Planner Stage)

- **输入**：用户请求 + 技能索引清单 (仅仅是技能列表 + `SKILL.md` 中的两三句话摘要，**不包含** CLI 脚本使用说明)。
- **动作**：大模型作为 Planner，决断需要哪些 `Skill` 完成任务（例如输出 `["deep-research"]`）。
- **优势**：此时 Context 只占用很少的 token，注意力集中在计划拆解本身上。

### 阶段 2：上下文懒加载与委派 (Delegation / Actor Stage)

- **动作**：系统创建一个对应的技能子代理节点 (Actor / SubAgent)。此时系统读取该技能内部的 `tools_schema.json`。
- **构建 Tool Context**：在对大模型发起的 `chat.completions` 请求中，将该 Schema 注入为 `tools: [...]`。
- **输出**：大模型必定输出标准的原生 `ToolCall` 调用对象：
  `{ name: "deep_research_engine", arguments: '{"query":"量子计算", "depth":2}' }`

### 阶段 3：沙盒安全转换与执行 (Execution Stage)

- 系统拦截到 LLM 稳定的 ToolCall JSON。
- 查阅 `entrypoints.json`，根据映射规则转换出实际的 Bash 命令：
  `python scripts/research.py --query '量子计算' --depth 2`
  *(框架层处理安全的 Shell Quote 反转义，规避所有的拼写错误和引号地狱)。*
- 在沙盒中执行完毕，拦截 `stdout/stderr`，将其解析为 JSON(如果能解析) 或者原始的 Text，再作为 `ToolMessage` 发送回 LLM。

## 5. 对比与演进优势

| 维度 | 旧版 V2 (Text/CLI Cache) | 本设计 (Hybrid Schema-Tool) |
| --- | --- | --- |
| **LLM 交互格式** | Markdown 内包裹 bash 命令块 ` ```bash...` | 原生原生的 `Tool Calls` |
| **校验拦截率** | 高（模型自己凭空拼脚本容易错，频频被框架退回要求重写） | 趋近于零（只要参数符合 JSON Schema，即可拼出 100% 正确的内部命令） |
| **Token 消耗** | 臃肿：要把长篇大论的命令行说明推到 prompt | 紧凑：只在要用的时候加载预先结构化定义的强类型函数签名 |
| **重构代价** | 在 Python 引擎里修改拦截校验逻辑 | 需要迁移所有旧技能，为它们补充一个简单的 `.json` 函数声明文件 |

## 6. 与 OpenClaw 的区别

1. **更强的透明度**：OpenClaw 把工具全用 SDK 的硬代码形式（类和函数）写在运行库里，LLM 不能“自我修改技能代码”。
2. **保留 Agent 自进化能力 (Evolve)**：本设计由于依然沿用了文件系统的 `skills` 目录和 `entrypoints.json` 脚本机制。未来，进化型 Agent (Evolution Center) 可以直接利用代码能力修改自己身旁的 `tools_schema.json` 和 `scripts/` 来“搓出”新的技能，实现**技能自定义热更新**的闭环。
