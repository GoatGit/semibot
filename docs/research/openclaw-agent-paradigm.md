# OpenClaw Agent 范式详解

> 本文档总结了 OpenClaw 开源项目的 Agent 架构设计和范式，供项目开发参考。
> 最后更新：2026-02-20

## 1. 项目概述

OpenClaw（原名 Clawdbot、Moltbot）是一个开源的自主 AI Agent 框架，专为开发者设计。它能够在本地运行，直接访问开发环境，并通过各种消息平台（Telegram、Discord、Slack、WhatsApp 等）与用户交互。

**核心特点：**
- 本地优先（Local-first）架构
- 模型无关（Model-agnostic）设计
- 可扩展的技能系统
- 持久化记忆能力
- Docker 沙箱安全执行

## 2. 核心架构组件

OpenClaw 采用模块化架构，由四个主要组件构成：

```
┌─────────────────────────────────────────────────────────────┐
│                        用户交互层                            │
│  (Telegram / Discord / Slack / WhatsApp / Web Interface)   │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                      Gateway（网关）                         │
│              处理消息路由和平台连接                           │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                      Brain（大脑）                           │
│         决策引擎 - 意图理解、工具选择、工作流编排              │
└─────────────────────────────────────────────────────────────┘
                              │
              ┌───────────────┼───────────────┐
              ▼               ▼               ▼
┌─────────────────┐ ┌─────────────────┐ ┌─────────────────┐
│  Skills（技能）  │ │  Memory（记忆）  │ │ Sandbox（沙箱）  │
│   模块化能力     │ │   持久化存储     │ │   安全执行环境   │
└─────────────────┘ └─────────────────┘ └─────────────────┘
```

### 2.1 Gateway（网关）

Gateway 是通信层，负责：
- 连接不同的消息平台（Telegram、Discord、Slack、WhatsApp 等）
- 处理传入消息并路由到核心系统
- 使用户能够通过熟悉的聊天界面与 Agent 交互

### 2.2 Brain（大脑）

Brain 是 OpenClaw 的决策引擎：
- **模型无关设计**：可集成 Claude、GPT-4 或本地模型
- **意图解析**：理解用户意图
- **工具选择**：决定使用哪些技能（Skills）
- **工作流编排**：协调执行流程

### 2.3 Skills（技能）

Skills 定义了 Agent 的能力：
- 预装 50+ 开箱即用的技能
- 支持自定义技能开发（JavaScript/TypeScript）
- 通过 ClawHub 公共注册表分享和获取技能
- 遵循 AgentSkills 标准格式（SKILL.md + YAML frontmatter）

### 2.4 Memory（记忆）

持久化记忆系统：
- 跨会话记忆过去的对话和上下文
- 配置、记忆和交互历史存储为 Markdown 文件
- 存放在标准文件夹中，便于透明访问

### 2.5 Sandbox（沙箱）

安全执行环境：
- 基于 Docker 的沙箱隔离
- 所有文件操作、命令执行在容器内进行
- 保护宿主系统和个人数据

## 3. Agentic Loop（Agent 循环）

OpenClaw 的核心是 **Agentic Loop**，这是一个持续循环的处理流程：

```
┌─────────────────────────────────────────────────────────────┐
│                      Agentic Loop                           │
│                                                             │
│  ┌──────────┐    ┌──────────┐    ┌──────────┐              │
│  │ 接收消息  │───▶│ 解析意图  │───▶│ 检索上下文│              │
│  └──────────┘    └──────────┘    └──────────┘              │
│                                        │                    │
│                                        ▼                    │
│  ┌──────────┐    ┌──────────┐    ┌──────────┐              │
│  │ 返回响应  │◀───│ 执行动作  │◀───│ 选择工具  │              │
│  └──────────┘    └──────────┘    └──────────┘              │
│        │                                                    │
│        └────────────────────────────────────────────────────┤
│                          循环继续                            │
└─────────────────────────────────────────────────────────────┘
```

### 循环步骤详解

| 步骤 | 说明 |
|------|------|
| 1. 接收消息 | 通过 Gateway 接收用户输入 |
| 2. 解析意图 | Brain 理解用户想要什么 |
| 3. 检索上下文 | 从 Memory 获取相关历史和偏好 |
| 4. 选择工具 | 决定使用哪些 Skills |
| 5. 执行动作 | 在 Sandbox 中安全执行 |
| 6. 返回响应 | 生成并返回结果给用户 |

### 设计特点

- **默认串行执行**：防止竞态条件，确保稳定性
- **显式并行**：特定任务可明确启用并行处理
- **单一控制平面**：优先可靠性
- **模块化可替换**：可更换模型、调整提示模板或更改记忆策略

## 4. Skills 技能系统

### 4.1 技能结构

技能遵循 AgentSkills 标准，使用 `SKILL.md` 文件定义：

```yaml
---
name: my-custom-skill
description: 执行特定任务的自定义技能
version: 1.0.0
author: developer
---

# My Custom Skill

## 使用说明
...

## 参数
...
```

**关键设计：** 技能不是 function-calling 工具定义，而是 LLM 操作手册（prompt 模板）。LLM 读取 SKILL.md 指令后，用已有工具（bash、文件读写等）执行。

**可选 frontmatter 字段：**
- `license` - 许可证
- `metadata` - 单行 JSON 对象，支持以下 gating 选项：
  - `user-invocable` - 暴露为斜杠命令
  - `disable-model-invocation` - 从模型 prompt 中排除
  - `requires` - 指定所需的二进制文件、环境变量或配置路径

**实际技能目录结构示例（Anthropic 的 pdf 技能）：**
```
pdf/
├── SKILL.md              <- frontmatter + LLM 操作指令
├── REFERENCE.md          <- 高级用法文档
├── FORMS.md              <- 表单处理指南
├── scripts/              <- Python CLI 脚本，LLM 通过 bash 调用
│   ├── check_fillable_fields.py
│   ├── fill_pdf_form_with_annotations.py
│   └── extract_form_field_info.py
└── LICENSE.txt
```

### 4.2 技能加载位置

三个加载位置（优先级从高到低）：

1. **工作区技能** (`<workspace>/skills/`) - 最高优先级，用户自建
2. **托管技能** (`~/.openclaw/skills/`) - OpenClaw 团队维护
3. **内置技能** - 随 OpenClaw 发行

工作区技能覆盖托管技能，托管技能覆盖内置技能。

**加载时过滤：** OpenClaw 在加载时根据以下条件过滤技能：
- 所需环境变量是否存在
- 所需二进制文件是否在系统上
- 配置设置是否满足
- 操作系统平台要求

### 4.3 运行时懒加载（三阶段）

1. **索引注入**（每条消息，低成本 ~50-100 tokens/技能）：轻量 `<available_skills>` 块附加到系统 prompt
2. **按需读取**（LLM 决定）：LLM 判断匹配后调用 `read_skill_file` 获取完整 SKILL.md（500-5000 tokens）
3. **执行**（LLM 按指令操作）：LLM 使用已有工具（bash、文件读写、代码执行）执行技能逻辑

### 4.4 内置技能类型

| 类型 | 示例 |
|------|------|
| 文件操作 | Read, Write, Edit |
| 浏览器自动化 | Web browsing, Screenshot |
| 命令执行 | Bash, Shell |
| API 集成 | HTTP requests, Webhooks |
| 工作流 | Multi-step orchestration |

### 4.5 自定义技能开发

```typescript
// skills/my-skill/index.ts
export default {
  name: 'my-skill',
  description: '自定义技能描述',

  async execute(context: SkillContext) {
    // 技能逻辑
    const result = await performTask(context.params);
    return result;
  }
};
```

### 4.6 ClawHub 技能市场

ClawHub 是 OpenClaw 的公共技能注册中心（clawhub.com / clawhub.ai）：

**核心特性：**
- 存储版本化的技能包（SKILL.md + 支持文件的目录）
- **Embedding 语义搜索**（非关键词匹配），发现技能更智能
- Semver 版本管理 + 变更日志
- 社区信号：Stars、下载量

**安全机制：**
- 发布者 GitHub 账号需注册满 1 周
- 社区举报达 3 次自动隐藏
- 管理员可解除隐藏、删除或封禁

**CLI 命令：**
```bash
# ClawHub CLI
clawhub install <slug>     # 安装技能
clawhub search <query>     # 语义搜索
clawhub update <slug>      # 更新技能
clawhub publish            # 发布技能
clawhub sync               # 批量扫描并发布
clawhub auth               # GitHub 认证

# OpenClaw CLI
openclaw skills list              # 列出所有技能
openclaw skills list --eligible   # 仅显示可用技能
openclaw skills info <name>       # 查看技能详情
openclaw skills check             # 验证技能依赖
```

**技能配置**（`~/.openclaw/openclaw.json` 的 `skills` 键）：
- `load.extraDirs` - 额外技能目录
- `load.watch` - 文件监听热重载
- `allowBundled` - 内置技能白名单
- `entries` - 每技能开关、环境变量注入、API Key 配置

### 4.7 工具组织

OpenClaw 将工具分组并通过访问 profile 控制：

| 工具组 | 说明 |
|--------|------|
| `group:fs` | 文件操作（read, write, edit, apply_patch） |
| `group:runtime` | 执行（exec, bash, process） |
| `group:sessions` | 会话管理 |
| `group:memory` | 记忆搜索/检索 |
| `group:web` | Web 搜索和抓取 |
| `group:ui` | 浏览器和画布控制 |
| `group:automation` | 定时任务和网关任务 |

工具 profile 提供基础白名单：`minimal`、`coding`、`messaging`、`full`。通过 `tools.allow`/`tools.deny` 控制访问。

## 5. Pi - 最小化 Agent

OpenClaw 底层有一个名为 **Pi** 的最小化编码 Agent：

```
┌─────────────────────────────────────────┐
│              Pi Agent                    │
│                                         │
│  核心工具：                              │
│  ├── Read   - 读取文件                   │
│  ├── Write  - 写入文件                   │
│  ├── Edit   - 编辑文件                   │
│  └── Bash   - 执行命令                   │
│                                         │
│  扩展系统：                              │
│  └── 扩展可持久化状态到会话              │
└─────────────────────────────────────────┘
```

Pi 的设计哲学：
- **极简核心**：仅保留最基础的工具
- **强大扩展**：通过扩展系统增强能力
- **状态持久化**：扩展可跨会话保持状态

## 6. 安全架构

### 6.1 三大风险类别

| 风险类型 | 说明 | 缓解措施 |
|---------|------|---------|
| Root Risk | 宿主系统被攻破 | Docker 隔离、最小权限 |
| Agency Risk | Agent 执行非预期的破坏性操作 | 沙箱执行、操作审批 |
| Keys Risk | 凭证被盗 | 凭证代理、环境变量隔离 |

### 6.2 Docker 沙箱安全配置

```yaml
# docker-compose.yml 安全配置示例
services:
  openclaw:
    image: openclaw/openclaw:latest
    security_opt:
      - no-new-privileges:true
    read_only: true
    networks:
      - openclaw-isolated
    volumes:
      - ./workspace:/workspace:rw  # 仅挂载必要目录
    environment:
      - SANDBOX_MODE=enabled
      - NETWORK_ACCESS=restricted
```

### 6.3 安全最佳实践

1. **启用沙箱模式**：始终在沙箱中执行敏感操作
2. **最小权限原则**：仅挂载必要目录，避免暴露 home 目录
3. **网络隔离**：将 OpenClaw 放入专用 Docker 网络
4. **工具访问限制**：限制高风险工具（exec、browser、web_fetch）
5. **认证配置**：配置网关认证，使用安全配对
6. **日志审计**：启用审计和会话日志
7. **工作区访问**：配置为只读或禁止访问

```typescript
// 安全配置示例
{
  "agents": {
    "defaults": {
      "sandbox": {
        "workspaceAccess": "ro",  // 只读
        "networkAccess": "none",   // 禁止网络
        "allowedTools": ["read", "write", "edit"]  // 白名单
      }
    }
  }
}
```

## 7. 与其他 Agent 框架对比

| 特性 | OpenClaw | Semibot | LangChain | AutoGPT |
|------|----------|---------|-----------|---------|
| 本地优先 | ✅ | ❌ SaaS | ❌ | ⚠️ |
| 模型无关 | ✅ | ✅ LLM Router | ✅ | ❌ |
| 消息平台集成 | ✅ | ❌ 仅 Web | ❌ | ❌ |
| 沙箱安全 | ✅ | ✅ Docker Pool + PolicyEngine | ❌ | ❌ |
| 持久化记忆 | ✅ Markdown | ✅ Redis + pgvector | ⚠️ | ✅ |
| 技能市场 | ✅ ClawHub | ❌ 计划中 | ⚠️ | ❌ |
| 最小化核心 | ✅ Pi | ❌ | ❌ | ❌ |
| 状态机编排 | ❌ 简单循环 | ✅ LangGraph | ⚠️ | ⚠️ |
| 多租户隔离 | ❌ | ✅ org_id 全链路 | ❌ | ❌ |
| 进化技能 | ❌ | ✅ 自动提取 + 审核 | ❌ | ❌ |
| MCP 集成 | ⚠️ 基础 | ✅ 多协议 + 连接池 | ❌ | ❌ |
| SubAgent 委托 | ❌ | ✅ delegate_node | ⚠️ | ✅ |

## 8. 应用场景

### 8.1 开发者工作流

```
用户: "帮我重构 src/utils 目录下所有的工具函数"

OpenClaw Agent:
1. [解析意图] 理解需要重构代码
2. [检索上下文] 获取项目结构和编码规范
3. [选择工具] 使用 Read、Edit 技能
4. [执行动作]
   - 扫描目录
   - 分析代码
   - 执行重构
5. [返回响应] 报告重构结果
```

### 8.2 自动化任务

- 日志分析和监控
- 代码审查辅助
- 文档生成和更新
- CI/CD 流程自动化
- 知识管理

## 9. 总结

OpenClaw Agent 范式的核心设计理念：

1. **模块化架构**：Gateway、Brain、Skills、Memory、Sandbox 各司其职
2. **Agentic Loop**：持续循环的消息处理-意图解析-工具执行-响应生成
3. **本地优先**：在用户设备上运行，保护隐私和数据控制
4. **安全沙箱**：Docker 隔离执行，防止系统被攻破
5. **可扩展技能**：AgentSkills 标准 + ClawHub 市场 + 懒加载机制
6. **最小化核心**：Pi Agent 展示了极简但强大的设计

### 与本项目（Semibot）的定位差异

| 维度 | OpenClaw | Semibot |
|------|----------|---------|
| 定位 | 开源个人 AI 助手框架 | 企业级 SaaS AI Agent 平台 |
| 部署模式 | 本地运行，无服务端 | 云端部署，多租户 |
| 技能生态 | 开放社区（ClawHub） | 管理员管控 |
| 编排能力 | 简单循环 | LangGraph 完整状态机 |
| 记忆系统 | Markdown 文件 | Redis + pgvector 分层 |
| 核心优势 | 社区生态 + 极简安装 | 企业管控 + 进化技能 + MCP 集成 |

### 可借鉴的方向

1. **语义搜索发现** - ClawHub 的 Embedding 搜索机制，本项目已有 EmbeddingService 基础可复用
2. **简化安装体验** - 类似 `clawhub install` 的一键安装 API
3. **社区信号** - Stars、下载量等帮助用户判断技能质量
4. **懒加载设计** - 本项目已采用相同的索引注入 + `read_skill_file` 按需读取模式

这种范式为构建可靠、安全、可扩展的 AI Agent 提供了良好的参考架构。详细对比分析见 [OpenClaw 与本项目架构对比分析](./openclaw-comparison-analysis.md)。

---

## 参考资料

- [OpenClaw GitHub Repository](https://github.com/openclaw/openclaw)
- [OpenClaw 官方文档](https://openclaw.ai)
- [ClawHub 技能注册中心](https://clawhub.ai)
- [OpenClaw 与本项目架构对比分析](./openclaw-comparison-analysis.md)
- [DigitalOcean - OpenClaw 部署指南](https://digitalocean.com)
- [CrowdStrike - AI Agent 安全](https://crowdstrike.com)
- [Composio - 凭证管理](https://composio.dev)
- [Analytics Vidhya - OpenClaw 教程](https://analyticsvidhya.com)
