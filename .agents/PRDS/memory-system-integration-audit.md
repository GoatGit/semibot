# Memory 系统集成审查 PRD

## 背景

基于 `docs/design/ARCHITECTURE.md` Section 4.3 的设计，Memory 系统分为：
- 短期记忆 (Short-term) — Redis，存储当前对话、工具结果、临时状态
- 长期记忆 (Long-term) — pgvector，存储历史总结、用户偏好、知识库

## 审查结论

代码实现层面相当完整，但存在关键集成缺陷：**Memory 系统未在 Runtime 启动时初始化**，导致整个系统实际不可用。

## 已实现（代码齐全）

| 模块 | 文件 | 说明 |
|------|------|------|
| 核心接口 | `runtime/src/memory/base.py` | MemorySystem 统一 API、抽象接口、数据类 |
| 短期记忆 | `runtime/src/memory/short_term.py` | Redis 实现，Lua 原子操作，TTL 过期，最大条目限制 |
| 长期记忆 | `runtime/src/memory/long_term.py` | pgvector 实现，语义搜索，多租户隔离，重要性评分 |
| 嵌入服务 | `runtime/src/memory/embedding.py` | OpenAI 嵌入，Redis 缓存，批量处理 |
| 数据库迁移 | `database/migrations/003_add_memory_tables.sql` | 4 个表 + 2 个搜索函数 |
| API 路由 | `apps/api/src/routes/v1/memory.ts` | 完整 REST API（CRUD + 搜索 + 清理） |
| API 服务 | `apps/api/src/services/memory.service.ts` | 业务逻辑层 |
| API 仓库 | `apps/api/src/repositories/memory.repository.ts` | 数据访问层 |
| 前端 Hook | `apps/web/hooks/useMemory.ts` | React Hook（加载、创建、删除、搜索） |
| 测试套件 | `runtime/tests/memory/` | 5 个测试文件，覆盖完整 |
| 配置常量 | `runtime/src/constants/config.py` | Redis/PG/嵌入/搜索配置 |
| Orchestrator | `runtime/src/orchestrator/nodes.py` | START 加载记忆、REFLECT 保存学习 |

## 缺陷清单

### P0 — 系统不可用

| # | 问题 | 位置 | 影响 |
|---|------|------|------|
| 1 | `app.py` lifespan 中未初始化 MemorySystem | `runtime/src/server/app.py` | 整个记忆系统不可用 |
| 2 | Redis 连接未创建 | `runtime/src/server/app.py` | 短期记忆不可用 |
| 3 | EmbeddingService 未初始化 | `runtime/src/server/app.py` | 向量搜索不可用 |

### P1 — 集成断裂

| # | 问题 | 位置 | 影响 |
|---|------|------|------|
| 4 | routes.py 构建 context 时未注入 `memory_system` | `runtime/src/server/routes.py` | Orchestrator 拿不到实例 |
| 5 | `.env.example` 缺少 REDIS_URL / DATABASE_URL | `.env.example` | 部署文档不全 |
| 6 | Memory 健康检查未暴露到 /health 端点 | `runtime/src/server/routes.py` | 可观测性差 |

### P2 — 功能缺失

| # | 问题 | 位置 | 影响 |
|---|------|------|------|
| 7 | 前端无 Memory 管理页面（只有 Hook 没有 UI） | `apps/web/` | 用户无法管理记忆 |
| 8 | 缺少定期清理过期记忆的任务 | `runtime/` | 数据库膨胀风险 |
| 9 | Memory 操作未记录审计日志 | `apps/api/` | 审计合规缺失 |
| 10 | API Repository JSONB 写入使用 JSON.stringify 而非 sql.json | `apps/api/src/repositories/memory.repository.ts` | 潜在数据问题 |

## 修复方案概要

### P0 修复（app.py 初始化）

在 `runtime/src/server/app.py` 的 `lifespan()` 中添加：

```python
from src.memory import MemorySystem, ShortTermMemory, LongTermMemory
from src.memory.embedding import EmbeddingService, OpenAIEmbeddingProvider

# 初始化 Embedding
embedding_provider = OpenAIEmbeddingProvider(api_key=os.getenv("OPENAI_API_KEY"))
embedding_service = EmbeddingService(provider=embedding_provider)

# 初始化 Memory
memory_system = MemorySystem(
    short_term=ShortTermMemory(redis_url=os.getenv("REDIS_URL", "redis://localhost:6379")),
    long_term=LongTermMemory(database_url=os.getenv("DATABASE_URL"), embedding_service=embedding_service),
)
app.state.memory_system = memory_system
```

### P1 修复（context 注入）

在 `runtime/src/server/routes.py` 构建 context 时添加：

```python
context = {
    "event_emitter": emitter,
    "llm_provider": llm_provider,
    "skill_registry": skill_registry,
    "memory_system": app.state.memory_system,  # 补上
}
```

## 验收标准

- [ ] Runtime 启动后 MemorySystem 实例存在于 app.state
- [ ] Orchestrator START 节点能加载短期记忆
- [ ] Orchestrator REFLECT 节点能保存长期记忆
- [ ] `/health` 端点包含 Memory 连接状态
- [ ] `.env.example` 包含所有必要环境变量
