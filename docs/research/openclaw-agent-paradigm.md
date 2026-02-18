# OpenClaw Agent 范式详解

> 本文档总结了 OpenClaw 开源项目的 Agent 架构设计和范式，供项目开发参考。

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

### 4.2 内置技能类型

| 类型 | 示例 |
|------|------|
| 文件操作 | Read, Write, Edit |
| 浏览器自动化 | Web browsing, Screenshot |
| 命令执行 | Bash, Shell |
| API 集成 | HTTP requests, Webhooks |
| 工作流 | Multi-step orchestration |

### 4.3 自定义技能开发

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

### 4.4 ClawHub 技能市场

ClawHub 是 OpenClaw 的公共技能注册表：
- 提供大量社区贡献的技能
- 通过 GUI 安装额外技能
- **安全提醒**：需警惕恶意技能，建议仅使用可信来源

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

| 特性 | OpenClaw | LangChain | AutoGPT |
|------|----------|-----------|---------|
| 本地优先 | ✅ | ❌ | ⚠️ |
| 模型无关 | ✅ | ✅ | ❌ |
| 消息平台集成 | ✅ | ❌ | ❌ |
| 沙箱安全 | ✅ | ❌ | ❌ |
| 持久化记忆 | ✅ | ⚠️ | ✅ |
| 技能市场 | ✅ (ClawHub) | ⚠️ | ❌ |
| 最小化核心 | ✅ (Pi) | ❌ | ❌ |

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
5. **可扩展技能**：AgentSkills 标准 + ClawHub 市场
6. **最小化核心**：Pi Agent 展示了极简但强大的设计

这种范式为构建可靠、安全、可扩展的 AI Agent 提供了良好的参考架构。

---

## 参考资料

- [OpenClaw GitHub Repository](https://github.com/openclaw/openclaw)
- [OpenClaw 官方文档](https://openclaw.ai)
- [DigitalOcean - OpenClaw 部署指南](https://digitalocean.com)
- [CrowdStrike - AI Agent 安全](https://crowdstrike.com)
- [Composio - 凭证管理](https://composio.dev)
- [Analytics Vidhya - OpenClaw 教程](https://analyticsvidhya.com)
