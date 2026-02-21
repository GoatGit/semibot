# OpenClaw 与本项目架构对比分析

> 本文档对比 OpenClaw 开源 Agent 框架与本项目（Semibot-S1）的架构差异，分析可改进之处。
> 最后更新：2026-02-20

## 1. 架构概览对比

### 1.1 OpenClaw 架构

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
│   模块化能力     │ │   Markdown文件   │ │   Docker隔离    │
└─────────────────┘ └─────────────────┘ └─────────────────┘
```

### 1.2 本项目架构

```
┌─────────────────────────────────────────────────────────────┐
│                      apps/web (前端)                         │
│                    Next.js + React                          │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                      apps/api (API层)                        │
│              Express + Repository 模式                       │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐      │
│  │ Skill Prompt │  │   Runtime    │  │     MCP      │      │
│  │   Builder    │  │   Adapter    │  │   Service    │      │
│  └──────────────┘  └──────────────┘  └──────────────┘      │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                  runtime (Python 运行时)                     │
│                                                             │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐      │
│  │ orchestrator │  │    agents    │  │    skills    │      │
│  │  (LangGraph) │  │ Base/Deleg.  │  │   Registry   │      │
│  └──────────────┘  └──────────────┘  └──────────────┘      │
│                                                             │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐      │
│  │   sandbox    │  │     mcp      │  │  evolution   │      │
│  │ Docker Pool  │  │   Client     │  │   Engine     │      │
│  └──────────────┘  └──────────────┘  └──────────────┘      │
│                                                             │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐      │
│  │    memory    │  │     llm      │  │    queue     │      │
│  │ Redis+pgvec │  │    Router    │  │   Producer   │      │
│  └──────────────┘  └──────────────┘  └──────────────┘      │
└─────────────────────────────────────────────────────────────┘
```

### 1.3 状态机对比

**OpenClaw Agentic Loop：**
```
接收消息 → 解析意图 → 检索上下文 → 选择工具 → 执行动作 → 返回响应
    ↑                                                      │
    └──────────────────────────────────────────────────────┘
```

**本项目 LangGraph 状态机：**
```
START → PLAN → ACT/DELEGATE → OBSERVE → REFLECT → RESPOND → END
              ↑______|              │
                     |______________|
```

**状态节点职责：**
- `start_node`：初始化上下文、加载记忆
- `plan_node`：解析意图、生成 ExecutionPlan
- `act_node`：执行工具/技能（支持并行）
- `delegate_node`：委托给 SubAgent
- `observe_node`：评估结果、决定下一步（replan/continue/done）
- `reflect_node`：总结学习、存储进化技能
- `respond_node`：生成最终响应

**条件路由：**
- `route_after_plan`：PLAN 后路由到 ACT / DELEGATE / RESPOND
- `route_after_observe`：OBSERVE 后路由到 PLAN / ACT / REFLECT

---

## 2. 核心组件对比

### 2.1 Brain / 决策引擎

| 对比项 | OpenClaw | 本项目 | 评价 |
|--------|----------|--------|------|
| 状态机实现 | 简单循环 | LangGraph 完整状态图 | ✅ 本项目更完善 |
| 规划能力 | 基础意图解析 | PLAN 节点 + ExecutionPlan | ✅ 本项目更优 |
| 反思机制 | 无明确实现 | REFLECT 节点 + ReflectionResult | ✅ 本项目更优 |
| 委托机制 | 无 | DELEGATE 节点 + SubAgent | ✅ 本项目更优 |
| 模型无关 | ✅ 支持多 LLM | ✅ LLM Router | 相当 |
| 条件路由 | 无 | route_after_plan/observe | ✅ 本项目更优 |

**结论：** 本项目的 Orchestrator 明显优于 OpenClaw 的简单循环。

### 2.2 Memory / 记忆系统

| 对比项 | OpenClaw | 本项目 | 评价 |
|--------|----------|--------|------|
| 短期记忆 | Markdown 文件 | Redis | ✅ 本项目更好 |
| 长期记忆 | Markdown 文件 | pgvector | ✅ 本项目更好 |
| 向量搜索 | 无 | EmbeddingService | ✅ 本项目更好 |
| 重要性评分 | 无 | importance 字段 | ✅ 本项目更好 |
| 缓存层 | 无 | RedisEmbeddingCache | ✅ 本项目更好 |

**结论：** 本项目的分层记忆系统（Short-term + Long-term + Embedding）远优于 OpenClaw 的文件存储。

### 2.3 Skills / 技能系统

| 对比项 | OpenClaw | 本项目 | 评价 |
|--------|----------|--------|------|
| 架构模型 | 单层：SKILL.md 目录即技能 | 双层：SkillDefinition（管理）+ SkillPackage（执行�� | ✅ 本项目更完善 |
| 技能格式 | SKILL.md + YAML frontmatter | SKILL.md（已移除 manifest.json） | 相当 |
| 技能注册 | ClawHub 公共注册中心 | 管理员管理 + 多来源安装 | ⚠️ OpenClaw 生态更开放 |
| 安装来源 | `clawhub install <slug>` | 手动 skill_id / manifest URL / 文件上传 / Anthropic 源 | ✅ 本项目来源更多 |
| 安装流程 | 简单下载到 `./skills/` | 状态机：pending → downloading → validating → installing → active | ✅ 本项目更健壮 |
| 安装审计 | 无 | skill_install_logs 完整审计表 | ✅ 本项目更好 |
| 版本管理 | 注册中心 semver | 数据库记录 + 文件系统 `{skillId}/{version}/` | ✅ 本项目更好 |
| 版本锁定 | 无 | agent_skills 支持 version_lock + auto_update | ✅ 本项目更好 |
| 懒加载 | 三阶段：索引 → read_skill_file → 执行 | 两阶段：索引注入 → read_skill_file 按需读取 | 相当（设计一致） |
| 技能发现 | Embedding 语义搜索 | 按名称/分类/标签过滤 | ⚠️ OpenClaw 更智能 |
| 社区生态 | 50+ 内置技能 + 社区贡献 + Stars/下载量 | 管理员管理，无公开市场 | ⚠️ OpenClaw 更开放 |
| 进化技能 | 无 | evolved_skills：LLM 自动生成 → 审核 → 向量检索复用 | ✅ 本项目独有 |
| 参数校验 | 基础 | OpenAPI-style ToolParameterSchema + Zod | ✅ 本项目更好 |
| 多租户 | 无（本地运行） | 全局可见 + 执行隔离（org_id 命名空间） | ✅ 本项目更好 |
| 工具类型 | 工具分组（fs/runtime/web/ui），profile 控制 | api/code/query/mcp/browser + MCP 集成 | 相当 |

**结论：** 本项目的技能系统在企业级管控（双层模型、安装审计、版本锁定、多租户隔离、进化技能）方面远优于 OpenClaw。OpenClaw 的优势在于开放的社区生态（ClawHub 注册中心）和语义搜索发现机制。

### 2.4 Gateway / 通信层

| 对比项 | OpenClaw | 本项目 | 评价 |
|--------|----------|--------|------|
| 多平台支持 | Telegram/Discord/Slack/WhatsApp | 仅 Web | ⚠️ OpenClaw 更好 |
| 消息路由 | 独立 Gateway 组件 | 无 | ⚠️ OpenClaw 更好 |
| 认证机制 | Gateway 认证 | API 中间件 | 相当 |

**结论：** 如需多渠道支持，可借鉴 OpenClaw 的 Gateway 设计。

### 2.5 Sandbox / 安全沙箱

| 对比项 | OpenClaw | 本项目 | 评价 |
|--------|----------|--------|------|
| Docker 沙箱 | ✅ 完整实现 | ✅ 完整实现（SandboxManager + SandboxPool） | 相当 |
| 工具权限控制 | ✅ 白名单机制 | ✅ PolicyEngine 安全策略引擎 | 相当 |
| 网络隔离 | ✅ | ✅ `network_mode: "none"` 默认隔离 | 相当 |
| 文件系统隔离 | ✅ | ✅ 只读文件系统选项 | 相当 |
| 工作区访问控制 | ro/rw/none | ✅ 支持 | 相当 |
| 容器池 | 无 | ✅ 预热容器池（默认 5 个，2x 溢出） | ✅ 本项目更好 |
| 资源限制 | 基础 | ✅ 内存 512MB / CPU 1 核 / Seccomp | ✅ 本项目更细 |
| 审计日志 | 基础 | ✅ 完整审计（session/agent/org 上下文 + 资源指标） | ✅ 本项目更好 |
| 多语言执行 | ✅ | ✅ Python / JavaScript / Bash | 相当 |

**结论：** 两者沙箱能力基本对齐，本项目在容器池预热、资源限制粒度和审计日志方面更完善。

### 2.6 MCP 集成

| 对比项 | OpenClaw | 本项目 | 评价 |
|--------|----------|--------|------|
| MCP 支持 | ✅ 基础支持 | ✅ 完整实现（McpClient + 连接池） | ✅ 本项目更好 |
| 传输类型 | STDIO | STDIO / HTTP-SSE / Streamable HTTP | ✅ 本项目更好 |
| 连接管理 | 基础 | 连接池 + 状态追踪 + 重试 + 超时 | ✅ 本项目更好 |
| Agent 绑定 | 无明确绑定 | Agent 可关联多个 MCP Server | ✅ 本项目更好 |

**结论：** 本项目的 MCP 集成更完善，支持多传输类型和连接池管理。

---

## 3. 本项目优势

### 3.1 更完善的状态机

本项目使用 LangGraph 实现了完整的状态机，包含：

```python
# 状态节点
- start_node    # 初始化上下文、加载记忆
- plan_node     # 规划执行计划
- act_node      # 执行工具（支持并行）
- delegate_node # 委托给子 Agent
- observe_node  # 观察执行结果、决定下一步
- reflect_node  # 反思总结、存储进化技能
- respond_node  # 生成响应

# 条件路由
- route_after_plan    # PLAN 后路由到 ACT/DELEGATE/RESPOND
- route_after_observe # OBSERVE 后路由到 PLAN/ACT/REFLECT
```

### 3.2 更强的记忆能力

```python
# 分层记忆架构
class MemorySystem:
    short_term: ShortTermMemory  # Redis - 当前会话（无 TTL 过期）
    long_term: LongTermMemory    # pgvector - 历史知识

# 向量检索能力
class EmbeddingService:
    provider: OpenAIEmbeddingProvider
    cache: RedisEmbeddingCache

# 优雅降级：Redis/PostgreSQL 不可用时仍可工作
```

### 3.3 更灵活的 Agent 体系

```python
# Agent 体系
BaseAgent
└── 支持 SubAgent 委托（delegate_node）

# Agent-Skills 绑定
agent_skills 表：
├── skill_definition_id  # 绑定技能定义
├── version_lock         # 版本锁定（^1.2.0, ~1.2.3）
├── auto_update          # 自动更新
├── priority             # 执行优先级
└── config_override      # 每 Agent 技能配置覆盖
```

### 3.4 完整的技能生命周期

```
安装 → 验证 → 激活 → 绑定 Agent → 懒加载 → 执行 → 进化 → 审核 → 复用
                                                      ↑
                                              evolved_skills 自动生成
```

- 双层模型：SkillDefinition（管理语义）+ SkillPackage（执行语义）
- 懒加载：索引注入（~50 token/技能）+ `read_skill_file` 按需读取
- 进化技能：LLM 自动从成功执行中提取技能 → 质量评分 → 审核 → 向量检索复用

### 3.5 Docker 沙箱隔离

```python
# 沙箱架构
SandboxManager
├── SandboxPool      # 预热容器池（默认 5 个，2x 溢出）
├── PolicyEngine     # 安全策略引擎
└── AuditLogger      # 执行审计

# 容器配置
- 非 root 用户（1000:1000）
- 内存限制：512MB / CPU 限制：1 核
- 网络隔离：network_mode: "none"
- 只读文件系统 / Seccomp profile
```

### 3.6 MCP 多协议集成

```python
# MCP 客户端
McpClient
├── STDIO 传输（本地进程）
├── HTTP-SSE 传输（服务端推送）
└── Streamable HTTP 传输（双向 HTTP）

# 特性
- 连接池 + 状态追踪
- 重试逻辑（指数退避，最多 3 次）
- 超时处理（连接 30s / 调用 60s）
- Agent 可关联多个 MCP Server
```

### 3.7 Checkpointing 支持

```python
# 支持状态持久化和恢复
create_agent_graph_with_checkpointer(
    context=context,
    checkpointer=checkpointer,  # 支持断点续传
)
```

---

## 4. 需要改进的方面

### 4.1 高优先级：技能市场 / 发现机制

**问题：** 缺少公开的技能注册中心和语义搜索发现机制。当前技能由管理员手动管理，用户无法自助发现和安装技能。

**借鉴 ClawHub 的设计：**

- **语义搜索**：ClawHub 使用 Embedding 语义搜索，而非关键词匹配。本项目已有 EmbeddingService 和 evolved_skills 的向量检索基础，可复用
- **简化安装 CLI**：ClawHub 的 `clawhub install <slug>` 体验极简，可考虑提供类似的一键安装能力
- **社区信号**：Stars、下载量、社区举报机制，帮助用户判断技能质量

**建议实现：**

```typescript
// 技能发现 API
GET /api/v1/skill-catalog/search?q=<query>  // 语义搜索
GET /api/v1/skill-catalog/popular            // 热门技能
GET /api/v1/skill-catalog/recommended        // 推荐技能

// 一键安装
POST /api/v1/skill-catalog/install
{ "slug": "pdf-tools", "version": "latest" }
```

### 4.2 中优先级：Human-in-the-Loop

**问题：** 有 checkpointer 但缺少明确的人工介入点。

**建议实现：**

```python
# runtime/src/orchestrator/hitl.py
from enum import Enum

class ApprovalStatus(Enum):
    PENDING = "pending"
    APPROVED = "approved"
    REJECTED = "rejected"
    MODIFIED = "modified"

@dataclass
class ApprovalRequest:
    """人工审批请求"""
    step_id: str
    action: str
    params: dict
    risk_level: str  # low/medium/high/critical
    reason: str

class HumanInTheLoop:
    """人工介入管理器"""

    # 需要人工审批的操作
    HIGH_RISK_ACTIONS = [
        "shell_exec",
        "file_delete",
        "database_modify",
        "api_call_external",
    ]

    async def request_approval(
        self,
        request: ApprovalRequest,
    ) -> ApprovalStatus:
        """请求人工审批"""
        # 1. 保存当前状态 (checkpoint)
        # 2. 发送审批请求到前端
        # 3. 等待用户响应
        # 4. 返回审批结果
        pass
```

### 4.3 低优先级：Gateway 多渠道支持

**问题：** 仅支持 Web 界面。

**建议实现（按需）：**

```python
# runtime/src/gateway/__init__.py
from abc import ABC, abstractmethod

class BaseGateway(ABC):
    """网关基类"""

    @abstractmethod
    async def receive_message(self) -> Message:
        pass

    @abstractmethod
    async def send_message(self, message: Message):
        pass

class WebGateway(BaseGateway):
    """Web 网关 (当前实现)"""
    pass

class DingTalkGateway(BaseGateway):
    """钉钉网关"""
    pass

class FeishuGateway(BaseGateway):
    """飞书网关"""
    pass
```

---

## 5. 关于 Pi Agent 的评估

### 5.1 Pi Agent 核心理念

```
Pi = 极简核心 + 强大扩展

核心工具（仅4个）：
├── Read   - 读取文件
├── Write  - 写入文件
├── Edit   - 编辑文件
└── Bash   - 执行命令

扩展机制：
└── 插件可持久化状态到会话
```

### 5.2 是否引入的建议

**结论：不建议完整引入 Pi Agent，但可借鉴其理念。**

| 因素 | 分析 |
|------|------|
| 架构重复 | 本项目已有完善的 Agent 体系 |
| 复杂度 | 引入 Pi 会增加架构复杂度 |
| 定位差异 | Pi 强调极简，本项目定位是完整平台 |
| 价值有限 | Pi 的价值在特定场景（纯编码任务） |

### 5.3 可借鉴的设计

**1. 核心工具分层**

```python
# runtime/src/skills/core.py
class CoreToolSet:
    """核心工具集 - 永远可用，最小权限"""

    TOOLS = [
        "file_read",
        "file_write",
        "file_edit",
        "shell_exec",
    ]

    @classmethod
    def is_core_tool(cls, tool_name: str) -> bool:
        return tool_name in cls.TOOLS
```

**2. 轻量级 Agent 模式**

```python
# runtime/src/agents/lite.py
class LiteAgent(BaseAgent):
    """轻量级 Agent - 仅使用核心工具，简化执行流程"""

    def __init__(self, config: AgentConfig):
        # 强制只使用核心技能
        config.skills = CoreToolSet.TOOLS
        super().__init__(config)

    async def execute(self, state: AgentState) -> AgentState:
        """简化的执行逻辑 - 跳过复杂的状态机"""
        # 理解 → 执行 → 响应（无 PLAN-OBSERVE-REFLECT）
        intent = await self._understand(state)
        result = await self._execute_core_tool(intent)
        return await self._respond(state, result)
```

**3. 扩展状态持久化**

```python
# runtime/src/skills/extension.py
class SkillExtension:
    """技能扩展 - 支持状态持久化"""

    def __init__(self, skill_id: str, redis_client: Redis):
        self.skill_id = skill_id
        self.redis = redis_client

    async def save_state(self, session_id: str, state: dict):
        """保存扩展状态到会话"""
        key = f"skill:{self.skill_id}:session:{session_id}:state"
        await self.redis.set(key, json.dumps(state))

    async def load_state(self, session_id: str) -> dict:
        """加载扩展状态"""
        key = f"skill:{self.skill_id}:session:{session_id}:state"
        data = await self.redis.get(key)
        return json.loads(data) if data else {}
```

---

## 6. 改进优先级总结

| 优先级 | 改进项 | 工作量 | 价值 | 建议 |
|--------|--------|--------|------|------|
| 🔴 高 | 技能市场 / 语义搜索发现 | 中 | 生态关键 | 复用 EmbeddingService 实现 |
| 🟡 中 | Human-in-the-Loop | 低 | 用户体验 | 下个迭代 |
| 🟢 低 | Gateway 多渠道 | 高 | 按需扩展 | 需求驱动 |
| ⚪ 可选 | LiteAgent 模式 | 低 | 特定场景 | 按需实现 |
| ⚪ 可选 | 核心工具分层 | 低 | 架构优化 | 重构时考虑 |

---

## 7. 结论

### 7.1 本项目的优势

1. **更完善的状态机** - LangGraph 实现的完整 Agent 循环（PLAN → ACT/DELEGATE → OBSERVE → REFLECT → RESPOND）
2. **更强的记忆系统** - Redis + pgvector 分层架构，支持优雅降级
3. **更好的规划能力** - ExecutionPlan + PlanStep + 条件路由
4. **反思机制** - REFLECT 节点支持经验总结 + 进化技能自动提取
5. **委托机制** - SubAgent 支持任务分解
6. **企业级技能管控** - 双层模型 + 安装审计 + 版本锁定 + 多租户隔离
7. **Docker 沙箱** - 预热容器池 + PolicyEngine + 完整审计
8. **MCP 多协议集成** - STDIO / HTTP-SSE / Streamable HTTP + 连接池
9. **进化技能** - LLM 自动生成 → 质量评分 → 审核 → 向量检索复用

### 7.2 主要差距

1. **技能市场 / 发现机制** - 缺少公开注册中心和语义搜索
2. **多渠道支持** - 仅有 Web 界面
3. **Human-in-the-Loop** - 缺少明确的人工介入点

### 7.3 建议路线图

```
Phase 1 (当前)
└── 技能市场 + 语义搜索发现机制

Phase 2 (下个迭代)
└── Human-in-the-Loop 人工介入

Phase 3 (按需)
├── Gateway 多渠道支持
└── LiteAgent 轻量模式
```

---

## 8. ClawHub 技能系统对比分析

> 本节专门对比 ClawHub（OpenClaw 的公共技能注册中心）与本项目技能系统的差异。

### 8.1 架构模型对比

| 维度 | Semibot | ClawHub (OpenClaw) |
|------|---------|-------------------|
| 核心模型 | 双层：SkillDefinition（管理） + SkillPackage（执行） | 单层：SKILL.md 目录即技能 |
| 元数据存储 | PostgreSQL 数据库（skill_definitions 表） | SKILL.md YAML frontmatter |
| 版本管理 | 数据库记录 + 文件系统目录 `{skillId}/{version}/` | 注册中心 semver 版本 |
| 必需文件 | SKILL.md（已移除 manifest.json） | 仅 SKILL.md |
| 多租户 | 全局可见 + 执行隔离（org_id 命名空间） | 无多租户概念，本地运行 |

### 8.2 安装机制对比

| 维度 | Semibot | ClawHub |
|------|---------|---------|
| 安装来源 | 手动 skill_id、manifest URL、文件上传、Anthropic 源 | `clawhub install <slug>` 从注册中心拉取 |
| 安装流程 | 状态机：pending → downloading → validating → installing → active | 简单下载到 `./skills/` 目录 |
| 安装日志 | 完整审计表（skill_install_logs），记录每步进度、耗时、错误 | 无专门审计机制 |
| 回滚 | 支持版本回滚 API | 手动删除/重装 |
| 校验 | SHA256 校验 + 目录结构验证 + Zod schema | 社区举报 + 账号年龄限制 |

### 8.3 运行时加载对比

| 维度 | Semibot | ClawHub |
|------|---------|---------|
| 加载策略 | 两阶段懒加载：索引注入 → `read_skill_file` 按需读取 | 三阶段懒加载：索引注入 → `read_skill_file` → 执行 |
| 技能绑定 | Agent-Skill 多对多绑定（agent_skills 表），支持优先级、版本锁定 | 三级目录覆盖：workspace > managed > bundled |
| 执行隔离 | SkillExecutionContext（orgId/sessionId/userId），沙箱资源限制 | 本地 Docker sandbox |
| 工具集成 | 统一 SkillRegistry（Python runtime），tool/skill 分层 | 工具分组（fs/runtime/web/ui），profile 控制访问 |

### 8.4 发现与分享对比

| 维度 | Semibot | ClawHub |
|------|---------|---------|
| 技能市场 | 无（计划中） | ClawHub 注册中心，支持语义搜索（embedding） |
| 发布机制 | 管理员手动创建/上传 | `clawhub publish` / `clawhub sync` 批量发布 |
| 搜索 | 按名称/分类/标签过滤 | Embedding 语义搜索 |
| 社区机制 | 无 | Stars、下载量、社区举报 |
| 进化技能 | 有（evolved_skills 表），支持 LLM 自动生成 + 审核 + 复用 | 无 |

### 8.5 各自优势总结

**Semibot 更强的地方：**
- 企业级多租户隔离，执行上下文完整（org/session/user/agent）
- 完整的安装状态机 + 审计日志，可追溯每次安装
- Agent-Skill 绑定支持优先级、版本锁定、自动更新
- 进化技能系统（LLM 自动生成 → 审核 → 复用），ClawHub 没有
- 沙箱执行有细粒度资源限制（CPU/内存/网络/文件系统）

**ClawHub 更强的地方：**
- 开放的公共注册中心，社区生态成熟（50+ 内置技能）
- 安装体验极简（一条命令），无需数据库
- Embedding 语义搜索，发现技能更智能
- 发布流程简单（`clawhub publish`），社区贡献门槛低
- 本地优先，无服务端依赖

### 8.6 可借鉴的方向

1. **语义搜索发现机制** - 复用已有的 EmbeddingService，为技能目录添加向量搜索
2. **简化安装体验** - 提供类似 `clawhub install` 的一键安装 API
3. **社区信号** - 引入使用量、评分等信号帮助用户判断技能质量（可复用 evolved_skills 的 use_count/success_count）

---

## 参考资料

- [OpenClaw Agent 范式详解](./openclaw-agent-paradigm.md)
- [本项目架构设计](./design/ARCHITECTURE.md)
- [数据模型设计](./design/DATA_MODEL.md)
