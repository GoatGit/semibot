# Memory 系统集成修复任务（2026-02-14）

## 审查来源

基于 `docs/design/ARCHITECTURE.md` Section 4.3 的 Memory System 设计审查。

## 审查结论

Memory 系统代码实现完整（短期/长期记忆、嵌入服务、API、数据库、前端 Hook、测试），但**未在 Runtime 启动时初始化**，整个系统实际不可用。

## 任务清单

### P0 — 立即修复（系统不可用）

- [ ] **T1**: 在 `runtime/src/server/app.py` lifespan 中初始化 MemorySystem
  - 创建 Redis 连接（ShortTermMemory）
  - 创建 EmbeddingService（OpenAIEmbeddingProvider）
  - 创建 LongTermMemory（PostgreSQL + pgvector）
  - 赋值到 `app.state.memory_system`

- [ ] **T2**: 在 `runtime/src/server/routes.py` 构建 context 时注入 `memory_system`
  - `context["memory_system"] = memory_system`（从 app.state 获取）

- [ ] **T3**: 确保 Redis 和 PostgreSQL 连接失败时优雅降级
  - Memory 不可用时 Orchestrator 仍能正常运行（跳过记忆加载/保存）

### P1 — 短期修复（集成完善）

- [ ] **T4**: `.env.example` 补充环境变量
  - `REDIS_URL`
  - `DATABASE_URL`
  - `OPENAI_API_KEY`（嵌入服务用）

- [ ] **T5**: `/health` 端点增加 Memory 连接状态检查

- [ ] **T6**: 修复 `apps/api/src/repositories/memory.repository.ts` 中 JSONB 写入
  - `JSON.stringify()` → `sql.json()`

### P2 — 中期完善

- [ ] **T7**: 创建前端 Memory 管理页面
  - 记忆列表、搜索、删除
  - 接入已有的 `useMemory` Hook

- [ ] **T8**: 实现定期清理过期记忆的后台任务

- [ ] **T9**: Memory 操作接入审计日志

## 相关文件

### 已实现（代码齐全）
- `runtime/src/memory/base.py` — 核心接口
- `runtime/src/memory/short_term.py` — Redis 短期记忆
- `runtime/src/memory/long_term.py` — pgvector 长期记忆
- `runtime/src/memory/embedding.py` — 嵌入服务
- `database/migrations/003_add_memory_tables.sql` — 数据库表
- `apps/api/src/routes/v1/memory.ts` — API 路由
- `apps/api/src/services/memory.service.ts` — 业务逻辑
- `apps/api/src/repositories/memory.repository.ts` — 数据访问
- `apps/web/hooks/useMemory.ts` — 前端 Hook
- `runtime/tests/memory/` — 测试套件
- `runtime/src/orchestrator/nodes.py` — START/REFLECT 节点已有记忆逻辑

### 需要修改
- `runtime/src/server/app.py` — 补充 MemorySystem 初始化（T1）
- `runtime/src/server/routes.py` — 补充 context 注入（T2）
- `.env.example` — 补充环境变量（T4）
- `apps/api/src/repositories/memory.repository.ts` — 修复 JSONB 写入（T6）

### 需要新建
- `apps/web/app/(dashboard)/memory/` — 前端管理页面（T7）

## 关联 PRD

- `.agents/PRDS/memory-system-integration-audit.md`
