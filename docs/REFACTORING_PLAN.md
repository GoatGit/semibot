# Semibot 重构设计方案

## 概述

基于项目现状的全面审查，以下 6 项重构能以较低风险显著提升代码质量和可维护性。按投入产出比排序。

---

## 1. Repository 泛型基类抽取

### 问题

14 个 Repository 都实现了相似的 `findById`、`findByIdAndOrg`、`findByOrg`、`create`、`update`、`softDelete`、`countByOrg`、`findByIds` 方法，大量重复代码。每新增一个实体就要复制粘贴一整套模板方法。

### 方案

抽取 `BaseRepository<TRow, TEntity>` 泛型基类，子类只需定义表名、列映射和特殊查询。

```typescript
// apps/api/src/repositories/base.repository.ts

export abstract class BaseRepository<TRow, TEntity> {
  constructor(
    protected readonly sql: Sql,
    protected readonly tableName: string,
  ) {}

  // 子类必须实现：行数据 → 实体转换
  protected abstract toEntity(row: TRow): TEntity;

  // 子类可选覆盖：默认查询列
  protected get selectColumns(): string {
    return '*';
  }

  async findById(id: string): Promise<TEntity | null> {
    const rows = await this.sql`
      SELECT ${this.sql(this.selectColumns)}
      FROM ${this.sql(this.tableName)}
      WHERE id = ${id} AND deleted_at IS NULL
    `;
    return rows.length > 0 ? this.toEntity(rows[0] as TRow) : null;
  }

  async findByIdAndOrg(id: string, orgId: string): Promise<TEntity | null> {
    const rows = await this.sql`
      SELECT ${this.sql(this.selectColumns)}
      FROM ${this.sql(this.tableName)}
      WHERE id = ${id} AND org_id = ${orgId} AND deleted_at IS NULL
    `;
    return rows.length > 0 ? this.toEntity(rows[0] as TRow) : null;
  }

  async findByOrg(orgId: string, page: number, limit: number): Promise<TEntity[]> {
    const offset = (page - 1) * limit;
    const rows = await this.sql`
      SELECT ${this.sql(this.selectColumns)}
      FROM ${this.sql(this.tableName)}
      WHERE org_id = ${orgId} AND deleted_at IS NULL
      ORDER BY created_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `;
    return rows.map((row) => this.toEntity(row as TRow));
  }

  async countByOrg(orgId: string): Promise<number> {
    const [{ count }] = await this.sql`
      SELECT COUNT(*) as count
      FROM ${this.sql(this.tableName)}
      WHERE org_id = ${orgId} AND deleted_at IS NULL
    `;
    return Number(count);
  }

  async softDelete(id: string, orgId: string, deletedBy: string): Promise<boolean> {
    const result = await this.sql`
      UPDATE ${this.sql(this.tableName)}
      SET deleted_at = NOW(), deleted_by = ${deletedBy}
      WHERE id = ${id} AND org_id = ${orgId} AND deleted_at IS NULL
    `;
    return result.count > 0;
  }

  async findByIds(ids: string[]): Promise<TEntity[]> {
    if (ids.length === 0) return [];
    const rows = await this.sql`
      SELECT ${this.sql(this.selectColumns)}
      FROM ${this.sql(this.tableName)}
      WHERE id = ANY(${ids}::uuid[]) AND deleted_at IS NULL
    `;
    return rows.map((row) => this.toEntity(row as TRow));
  }
}
```

子类示例：

```typescript
// apps/api/src/repositories/agent.repository.ts
export class AgentRepository extends BaseRepository<AgentRow, Agent> {
  constructor(sql: Sql) {
    super(sql, 'agents');
  }

  protected toEntity(row: AgentRow): Agent {
    return { id: row.id, name: row.name, /* ... */ };
  }

  // 仅定义特殊查询
  async findByIsSystem(orgId: string): Promise<Agent[]> {
    const rows = await this.sql`
      SELECT * FROM agents WHERE org_id = ${orgId} AND is_system = true AND deleted_at IS NULL
    `;
    return rows.map((row) => this.toEntity(row as AgentRow));
  }
}
```

### 影响范围

- 新增 `apps/api/src/repositories/base.repository.ts`
- 重构 14 个 Repository 文件继承基类
- 预计减少约 60% 的 Repository 层代码

### 风险

低。纯内部重构，不改变外部接口。逐个 Repository 迁移，每次迁移后跑测试验证。

---

## 2. LLM Provider 去重

### 问题

API 层（`apps/api/src/services/llm/`）和 Runtime 层（`runtime/src/llm/`）各自实现了一套 LLM 适配层。两层都有 OpenAI、Anthropic、Google 等 provider 的实现，逻辑重复且可能行为不一致。

### 方案

**方案 A（推荐）：API 层统一通过 Runtime 调用 LLM**

API 层不再直接调用 LLM API，所有 LLM 调用都通过 Runtime 的 HTTP 接口。API 层的 LLM provider 仅保留用于模型列表查询和健康检查等管理功能。

```
当前：
  API 层 → OpenAI/Anthropic/Google API（直接调用）
  Runtime 层 → OpenAI/Anthropic/Google API（直接调用）

目标：
  API 层 → Runtime HTTP API → OpenAI/Anthropic/Google API
  API 层 → LLM Provider（仅管理：模型列表、健康检查）
```

**方案 B：抽取共享 LLM 包**

将 LLM 适配层下沉到 `packages/llm-adapter/`，API 层和 Runtime 层共同引用。但跨语言（TS + Python）共享成本较高，不推荐。

### 影响范围

- 修改 `apps/api/src/services/chat.service.ts` — 移除直接 LLM 调用，统一走 Runtime
- 简化 `apps/api/src/services/llm/` — 仅保留管理功能
- Runtime 层不变

### 风险

中。需要确保 Runtime 的 LLM 调用接口覆盖 API 层当前的所有使用场景（流式/非流式、多模型）。

---

## 3. SSE 通信层抽取

### 问题

SSE 实现散落在 `chat.service.ts` 中，连接管理、心跳、事件分发、连接限制等逻辑与业务逻辑耦合。未来如果要支持 WebSocket 或增加 SSE 消息缓冲，改动面很大。

### 方案

抽取独立的 `SSEManager` 类，职责单一。

```typescript
// apps/api/src/lib/sse-manager.ts

export class SSEManager {
  private connections: Map<string, SSEConnection> = new Map();
  private messageBuffer: Map<string, CircularBuffer<SSEMessage>> = new Map();

  // 连接生命周期
  createConnection(connectionId: string, res: Response, options: SSEOptions): void;
  closeConnection(connectionId: string): void;

  // 消息发送
  send(connectionId: string, event: string, data: unknown): void;
  broadcast(orgId: string, event: string, data: unknown): void;

  // 心跳管理
  private startHeartbeat(connectionId: string): void;
  private stopHeartbeat(connectionId: string): void;

  // 连接限制
  checkConnectionLimit(userId: string, orgId: string): boolean;

  // 消息缓冲（支持断线重连）
  getBufferedMessages(connectionId: string, lastEventId: number): SSEMessage[];

  // 统计
  getConnectionCount(orgId?: string): number;
}
```

### 影响范围

- 新增 `apps/api/src/lib/sse-manager.ts`
- 重构 `apps/api/src/services/chat.service.ts` — 使用 SSEManager
- 前端 `useSSE.ts` 不变（接口兼容）

### 风险

低。内部重构，SSE 协议不变。

---

## 4. 跨层错误协议统一

### 问题

API 层用 `createError()` + errorCodes（TypeScript），Runtime 层��� Python 异常。跨层错误传递时格式不统一，前端需要处理两种不同的错误结构。

### 方案

定义跨层统一的错误 JSON 协议，在 `packages/shared-types/` 中声明：

```typescript
// packages/shared-types/src/error.ts
export interface UnifiedError {
  code: string;          // 错误码，如 'RESOURCE_NOT_FOUND'
  message: string;       // 用户可见消息
  httpStatus: number;    // HTTP 状态码
  details?: unknown;     // 附加信息
  traceId?: string;      // 请求追踪 ID
}
```

Runtime 层的 HTTP 响应统一使用此格式：

```python
# runtime/src/server/errors.py
class UnifiedError(Exception):
    def __init__(self, code: str, message: str, http_status: int = 500, details=None):
        self.code = code
        self.message = message
        self.http_status = http_status
        self.details = details

    def to_dict(self):
        return {"code": self.code, "message": self.message, "details": self.details}
```

API 层在调用 Runtime 时，将 Runtime 返回的错误转换为 API 层的 `createError()`：

```typescript
// apps/api/src/adapters/runtime.adapter.ts
function handleRuntimeError(runtimeError: UnifiedError) {
  throw createError(runtimeError.httpStatus, runtimeError.code, runtimeError.message);
}
```

### 影响范围

- 新增 `packages/shared-types/src/error.ts`
- 新增 `runtime/src/server/errors.py`
- 修改 `apps/api/src/adapters/runtime.adapter.ts` — 错误转换
- 修改 Runtime 各模块的异常抛出

### 风险

中。需要逐步迁移 Runtime 的异常处理，确保所有错误路径都覆盖。

---

## 5. 请求追踪中间件（Trace ID）

### 问题

一个请求从 API 层进入，经过 Runtime 执行，再返回结果，全链路没有统一的 trace ID。排查问题时无法关联不同层的日志。

### 方案

添加请求追踪中间件，生成或透传 `X-Request-ID`：

```typescript
// apps/api/src/middleware/tracing.ts
export function tracing() {
  return (req, res, next) => {
    const traceId = req.headers['x-request-id'] || crypto.randomUUID();
    req.traceId = traceId;
    res.setHeader('X-Request-ID', traceId);

    // 注入到 logger 上下文
    const childLogger = logger.child({ traceId });
    req.logger = childLogger;

    next();
  };
}
```

调用 Runtime 时透传 trace ID：

```typescript
// apps/api/src/adapters/runtime.adapter.ts
const response = await fetch(runtimeUrl, {
  headers: { 'X-Request-ID': req.traceId },
});
```

Runtime 侧接收并注入到日志：

```python
# runtime/src/server/middleware.py
@app.middleware("http")
async def trace_middleware(request, call_next):
    trace_id = request.headers.get("x-request-id", str(uuid4()))
    request.state.trace_id = trace_id
    response = await call_next(request)
    response.headers["x-request-id"] = trace_id
    return response
```

### 影响范围

- 新增 `apps/api/src/middleware/tracing.ts`
- 修改 `apps/api/src/app.ts` — 注册中间件
- 修改 `apps/api/src/adapters/runtime.adapter.ts` — 透传 trace ID
- 新增 `runtime/src/server/middleware.py` — 接收 trace ID
- 修改日志调用处注入 traceId

### 风险

低。纯增量改动，不影响现有逻辑。

---

## 6. 前后端类型自动同步

### 问题

`packages/shared-types` 手动维护，前端 `types/index.ts` 从 shared-types 重新导出并扩展。Zod Schema（路由验证）和 TypeScript 类型（shared-types）需要手动保持一致，容易出现不同步。

### 方案

以 Zod Schema 为单一来源，自动生成 TypeScript 类型：

```typescript
// packages/shared-types/src/agent.ts
import { z } from 'zod';

// Zod Schema 是唯一来源
export const createAgentSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().optional(),
  modelConfig: agentModelConfigSchema,
});

// 类型从 Schema 自动推导
export type CreateAgentInput = z.infer<typeof createAgentSchema>;
```

路由层直接引用同一个 Schema：

```typescript
// apps/api/src/routes/v1/agents.ts
import { createAgentSchema } from '@semibot/shared-types';

router.post('/', validate(createAgentSchema), createAgent);
```

### 影响范围

- 重构 `packages/shared-types/src/` — 以 Zod Schema 为基础
- 修改 `apps/api/src/routes/v1/` — 引用 shared-types 的 Schema
- 前端 `types/index.ts` 不变（仍从 shared-types 导入）

### 风险

中。需要逐步迁移，确保 Zod Schema 和现有类型定义完全一致。建议按模块逐个迁移。

---

## 执行优先级

| 序号 | 重构项 | 投入 | 收益 | 建议顺序 |
|------|--------|------|------|---------|
| 1 | Repository 泛型基类 | 中 | 高（减少 60% 重复代码） | 第一批 |
| 5 | 请求追踪中间件 | 低 | 高（排障效率大幅提升） | 第一批 |
| 3 | SSE 通信层抽取 | 低 | 中（为消息缓冲铺路） | 第二批 |
| 4 | 跨层错误协议统一 | 中 | 中（前端错误处理简化） | 第二批 |
| 2 | LLM Provider 去重 | 高 | 高（消除重复，行为一致） | 第三批 |
| 6 | 前后端类型自动同步 | 高 | 中（减少手动同步） | 第三批 |
