# 借鉴 OpenClaw：Semibot 能力补齐需求

## 概述

OpenClaw 是 150k+ star 的开源个人 AI 助手平台，采用 local-first 架构，以 Gateway 为中心的 hub-and-spoke 模型。虽然定位不同（OpenClaw 面向个人用户，Semibot 面向 B 端多租户），但其在渠道集成、技能生态、上下文管理、成本控制等方面的设计值得 Semibot 学习和借鉴。

以下按优先级排列 Semibot 应补齐的能力。

---

## 1. 多渠道消息接入层（Gateway）

### OpenClaw 做法

Gateway 绑定 WebSocket，作为所有消息渠道的统一入口。支持 13+ 平台（WhatsApp、Telegram、Slack、Discord、微信等），不同渠道/账号可路由到隔离的 Agent，每个 Agent 有独立的 workspace 和 session。

### Semibot 现状

仅有 Web UI 一个入口，无任何第三方渠道集成。

### 需求

#### 1.1 消息网关抽象层

设计统一的消息网关接口，屏蔽不同渠道的协议差异：

```typescript
// packages/shared-types/src/channel.ts
export interface ChannelMessage {
  channelType: 'web' | 'slack' | 'telegram' | 'dingtalk' | 'wechat_work' | 'feishu';
  channelId: string;        // 渠道实例 ID
  senderId: string;         // 发送者在渠道中的 ID
  content: string;          // 消息内容
  attachments?: Attachment[];
  metadata?: Record<string, unknown>;  // 渠道特有元数据
}

export interface ChannelAdapter {
  type: string;
  connect(config: ChannelConfig): Promise<void>;
  disconnect(): Promise<void>;
  sendMessage(channelId: string, message: OutboundMessage): Promise<void>;
  onMessage(handler: (msg: ChannelMessage) => Promise<void>): void;
}
```

#### 1.2 初期支持渠道（按 B 端优先级）

| 优先级 | 渠道 | 说明 |
|--------|------|------|
| P0 | Web UI | 已有 |
| P1 | Slack | B 端最常用 |
| P1 | 钉钉 | 国内 B 端主流 |
| P1 | 飞书 | 国内 B 端主流 |
| P2 | Telegram | 海外用户 |
| P2 | 企业微信 | 国内 B 端 |

#### 1.3 渠道路由

- 每个渠道实例可绑定到指定 Agent
- 支持 mention 激活（群聊中 @bot 才响应）和 always-on 模式（私聊自动响应）
- 渠道消息统一转换为内部 Session/Message 模型

### 涉及文件

- 新增 `apps/api/src/channels/` 目录 — 渠道适配器
- 新增 `apps/api/src/channels/gateway.ts` — 消息网关
- 新增 `apps/api/src/channels/adapters/slack.ts`
- 新增 `apps/api/src/channels/adapters/dingtalk.ts`
- 新增 `apps/api/src/channels/adapters/feishu.ts`
- 新增数据库表 `channels`、`channel_configs`
- 修改 `apps/api/src/services/chat.service.ts` — 接入网关

### 优先级

**P1 — B 端产品的核心差异化能力**

---

## 2. 智能上下文管理

### OpenClaw 做法

三级上下文裁剪策略：
1. 先移除旧的 tool results（保留 tool call 摘要）
2. 再将旧消息压缩为摘要（LLM 生成）
3. 最后按需加载 bootstrap 文件

还提供 `/compact` 命令手动压缩上下文。

### Semibot 现状

有短期记忆（Redis）和长期记忆（pgvector），但缺少自动上下文裁剪和压缩机制。长对话容易 token 溢出，要么截断丢失上下文，要么超出模型限制报错。

### 需求

#### 2.1 自动上下文裁剪

```python
# runtime/src/memory/context_manager.py

class ContextManager:
    """三级上下文裁剪策略"""

    async def fit_context(self, messages: list, max_tokens: int) -> list:
        """将消息列表裁剪到 max_tokens 以内"""
        current_tokens = self.count_tokens(messages)

        if current_tokens <= max_tokens:
            return messages

        # Level 1: 移除旧的 tool_result 内容，保留摘要
        messages = self._trim_tool_results(messages)
        if self.count_tokens(messages) <= max_tokens:
            return messages

        # Level 2: 压缩旧消息为摘要
        messages = await self._compress_old_messages(messages, max_tokens)
        if self.count_tokens(messages) <= max_tokens:
            return messages

        # Level 3: 滑动窗口，保留最近 N 条 + 系统消息
        messages = self._sliding_window(messages, max_tokens)
        return messages
```

#### 2.2 Tool Result 智能摘要

工具返回的大量数据（如数据库查询结果、网页内容）在后续对话中不需要完整保留。自动将超过阈值的 tool_result 替换为 LLM 生成的摘要。

#### 2.3 手动压缩命令

在对话中支持 `/compact` 指令，触发当前会话的上下文压缩，用户可感知地释放 token 空间。

### 涉及文件

- 新增 `runtime/src/memory/context_manager.py`
- 修改 `runtime/src/orchestrator/nodes.py` — START 节点接入上下文管理
- 修改 `runtime/src/server/routes.py` — 支持 /compact 指令

### 优先级

**P0 — 长对话体验的核心保障**

---

## 3. 技能生态与分发

### OpenClaw 做法

ClawHub 社区市场（700+ 技能），技能以 `SKILL.md` 为核心的标准化格式，支持一键安装。三层技能体系：Bundled（内置）→ Managed（社区托管）→ Workspace（用户自建）。

### Semibot 现状

技能系统支持多源安装（Anthropic/URL/上传/Git/Registry），但没有社区市场和标准化的技能分发机制。技能发现依赖手动配置。

### 需求

#### 3.1 技能市场（Skill Marketplace）

- 组织内技能共享：组织成员可发布技能供同组织其他 Agent 使用
- 公开技能市场：标记为 `is_public` 的技能可被其他组织发现和安装
- 技能评分和使用统计
- 技能分类和标签搜索

#### 3.2 技能标准化格式

统一技能描述格式，便于分发和安装：

```markdown
<!-- SKILL.md -->
---
name: data-analyzer
version: 1.0.0
description: 数据分析技能，支持 CSV/Excel 文件分析和可视化
author: semibot-team
tags: [data, analysis, visualization]
requires:
  tools: [code_executor, file_reader]
  models: [gpt-4o, claude-sonnet-4-20250514]
---

# Data Analyzer

## 触发条件
当用户上传数据文件或要求数据分析时触发。

## 执行步骤
1. 读取数据文件
2. 分析数据结构和统计特征
3. 生成可视化图表
4. 输出分析报告
```

#### 3.3 技能组合

支持技能之间的依赖和组合，一个技能可以声明依赖其他技能，安装时自动解析依赖链。

### 涉及文件

- 新增 `apps/api/src/routes/v1/marketplace.ts`
- 新增 `apps/api/src/services/marketplace.service.ts`
- 修改 `apps/api/src/services/skill.service.ts` — 支持发布和安装
- 新增数据库表 `skill_ratings`、`skill_installs`
- 前端新增技能市场页面

### 优先级

**P2 — 生态建设，中长期价值**

---

## 4. 智能模型路由（成本优化）

### OpenClaw 做法

ClawRouter 根据任务复杂度自动选择最经济的模型，节省约 92% 成本。不同任务类型路���到不同模型。

### Semibot 现状

有 LLMRouter 和 `task_model_routing`，但粒度较粗（只按 planning/execution/reflection 三种任务类型分），没有基于任务复杂度的动态路由。

### 需求

#### 4.1 任务复杂度评估

在路由前对任务进行复杂度评估：

```python
# runtime/src/llm/complexity_scorer.py

class ComplexityScorer:
    """任务复杂度评估器"""

    def score(self, messages: list, tools: list) -> float:
        """返回 0-1 的复杂度分数"""
        factors = {
            'message_length': self._score_length(messages),
            'tool_count': self._score_tools(tools),
            'reasoning_depth': self._score_reasoning(messages),
            'domain_specificity': self._score_domain(messages),
        }
        return weighted_average(factors)
```

#### 4.2 动态模型选择

```python
# runtime/src/llm/smart_router.py

class SmartRouter:
    """基于复杂度的智能模型路由"""

    ROUTING_TABLE = {
        (0.0, 0.3): 'gpt-4o-mini',      # 简单任务
        (0.3, 0.6): 'gpt-4o',            # 中等任务
        (0.6, 0.8): 'claude-sonnet-4-20250514',  # 复杂任务
        (0.8, 1.0): 'claude-opus-4-20250115',    # 高复杂度任务
    }

    async def route(self, messages, tools, task_type) -> str:
        complexity = self.scorer.score(messages, tools)
        # 结合任务类型和复杂度选择模型
        model = self._select_model(complexity, task_type)
        logger.info(f'[SmartRouter] 复杂度={complexity:.2f}, 选择模型={model}')
        return model
```

#### 4.3 成本追踪

- 每次调用记录实际使用的模型和 token 消耗
- 提供成本分析面板：按模型、按任务类型、按时间段统计
- 对比智能路由 vs 固定模型的成本差异

### 涉及文件

- 新增 `runtime/src/llm/complexity_scorer.py`
- 新增 `runtime/src/llm/smart_router.py`
- 修改 `runtime/src/llm/router.py` — 集成智能路由
- 修改 `apps/api/src/routes/v1/logs.ts` — 新增成本分析端点

### 优先级

**P1 — 直接影响运营成本**

---

## 5. Agent 实时监控面板

### OpenClaw 做法

Crabwalk（实时监控伴侣工具）和 Mission Control（多 Agent 编排仪表盘，Kanban 任务管理 + AI 规划 + 实时事件流）。

### Semibot 现状

有执行日志和使用量统计，但缺少实时的 Agent 执行监控。用户无法直观看到 Agent 当前在做什么、执行到哪一步、资源消耗情况。

### 需求

#### 5.1 实时执行监控

- 当前活跃的 Agent 执行列表
- 每个执行的实时状态（当前节点、已执行步骤、耗时）
- 工具调用实时流（正在调用什么工具、参数、结果）
- 支持中断正在执行的任务

#### 5.2 资源仪表盘

- Token 消耗趋势图（按小时/天/周）
- 模型使用分布（饼图）
- 活跃 Agent 排行
- 错误率和成功率趋势
- 平均响应时间

#### 5.3 告警规则

- 错误率超过阈值告警
- Token 消耗异常告警
- Agent 执行超时告警
- 通过 Webhook 推送告警（依赖 Webhook 系统）

### 涉及文件

- 新增 `apps/web/app/(dashboard)/monitor/page.tsx` — 监控面板页面
- 新增 `apps/web/hooks/useMonitor.ts`
- 新增 `apps/api/src/routes/v1/monitor.ts` — 监控数据 API
- 新增 `apps/api/src/services/monitor.service.ts`

### 优先级

**P2 — 运维可观测性，B 端客户关注**

---

## 6. 自动化调度（Cron + 触发器）

### OpenClaw 做法

内置 Cron 定时任务、Webhooks 触发、Gmail Pub/Sub、Heartbeat 唤醒机制（250ms 窗口合并 + 24 小时去重调度）。Agent 不仅被动响应对话，还能主动执行定时任务。

### Semibot 现状

Agent 仅在用户发起对话时被动执行，没有定时任务或事件触发机制。

### 需求

#### 6.1 定时任务

- 用户可为 Agent 配置 Cron 表达式
- 定时触发 Agent 执行指定任务（如每日数据报告、定期检查）
- 支持启用/禁用、执行历史查看

#### 6.2 事件触发器

- Webhook 触发：外部系统通过 HTTP 调用触发 Agent 执行
- 条件触发：基于数据变化或阈值触发（如监控指标异常时自动分析）

### 涉及文件

- 新增 `apps/api/src/services/scheduler.service.ts`
- 新增 `apps/api/src/routes/v1/schedules.ts`
- 新增数据库表 `agent_schedules`、`schedule_logs`
- 修改 `apps/api/src/app.ts` — 启动调度器

### 优先级

**P2 — Agent 自动化能力扩展**

---

## 总结：优先级排序

| 序号 | 能力 | 优先级 | 核心价值 |
|------|------|--------|---------|
| 2 | 智能上下文管理 | P0 | 长对话体验保障 |
| 1 | 多渠道消息接入 | P1 | B 端差异化 |
| 4 | 智能模型路由 | P1 | 成本优化 |
| 3 | 技能生态与分发 | P2 | 中长期生态 |
| 5 | 实时监控面板 | P2 | 运维可观测性 |
| 6 | 自动化调度 | P2 | Agent 自动化 |
