# API 规范

## 字段命名

**统一使用 camelCase**，禁止 snake_case。

```typescript
// ✅ 正确
{ userId, createdAt, refreshToken, expiresAt }

// ❌ 错误
{ user_id, created_at, refresh_token, expires_at }
```

---

## 类型定义

**后端 Schema 与 shared-types 必须对齐。**

### DTO 命名规范

| 用途 | 命名格式 | 示例 |
|------|----------|------|
| 创建输入 | `CreateXxxInput` | `CreateAgentInput` |
| 更新输入 | `UpdateXxxInput` | `UpdateAgentInput` |
| 响应类型 | `XxxResponse` | `AgentResponse` |

### 示例

```typescript
// packages/shared-types/src/dto.ts
export interface CreateAgentInput {
  name: string;
  description?: string;
  modelConfig: AgentModelConfig;
}

export interface UpdateAgentInput {
  name?: string;
  description?: string;
}
```

---

## 输入验证

**所有 API 路由必须使用 Zod Schema 验证。**

```typescript
// routes/v1/agents.ts
const createAgentSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().optional(),
  modelConfig: agentModelConfigSchema,
});

router.post('/', validate(createAgentSchema), createAgent);
```

### UUID 验证

```typescript
const idSchema = z.string().uuid();

// 路由参数验证
router.get('/:id', validate(z.object({ id: idSchema })), getAgent);
```

---

## 响应格式

### 成功响应

```typescript
interface ApiResponse<T> {
  success: true;
  data: T;
  meta?: PaginationMeta;
}
```

### 错误响应

```typescript
interface ApiErrorResponse {
  success: false;
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}
```

### 分页

```typescript
interface PaginationMeta {
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

interface CursorPaginationMeta {
  nextCursor?: string;
  hasMore: boolean;
}
```
