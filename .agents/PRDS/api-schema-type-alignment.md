# PRD: 后端 Schema 与 Shared Types 对齐

## 概述

后端 Zod Schema 定义与 `@semibot/shared-types` 中的 TypeScript 类型定义存在不一致。

## 问题描述

### 1. Agent 配置字段必填性不一致

**后端 Zod Schema** (`agents.ts:22-30`):
```typescript
config: z.object({
  model: z.string().optional(),           // 可选
  temperature: z.number().optional(),     // 可选
  maxTokens: z.number().optional(),       // 可选
  timeoutSeconds: z.number().optional(),  // 可选
}).optional()
```

**Shared Types** (`agent.ts:14-27`):
```typescript
interface AgentModelConfig {
  model: string;           // 必填
  temperature: number;     // 必填
  maxTokens: number;       // 必填
  timeoutSeconds: number;  // 必填
}
```

### 2. Session 更新字段限制

**后端只接受**:
- `title`
- `status`

**前端发送** `Partial<Session>`，可能包含不被接受的字段。

### 3. Message 字段命名不一致

**Chat 路由** (`chat.ts:19`):
```typescript
parentMessageId: z.string().uuid().optional()
```

**Sessions 路由** (`sessions.ts:39`):
```typescript
parentId: z.string().uuid().optional()
```

同样表示父消息 ID，命名不一致。

## 目标

1. 统一后端 Schema 和 Shared Types 的必填性
2. 统一字段命名
3. 前端发送数据时只包含有效字段

## 技术方案

### 1. 更新 Shared Types

```typescript
// agent.ts - 区分创建和更新场景
interface AgentModelConfig {
  model?: string;           // 创建时可选，有默认值
  temperature?: number;
  maxTokens?: number;
  timeoutSeconds?: number;
  retryAttempts?: number;
  fallbackModel?: string;
}

// 运行时完整配置（填充默认值后）
interface ResolvedAgentModelConfig {
  model: string;
  temperature: number;
  maxTokens: number;
  timeoutSeconds: number;
  retryAttempts: number;
  fallbackModel?: string;
}
```

### 2. 统一 parentId 命名

建议统一使用 `parentMessageId`，更明确表达语义。

### 3. 创建 DTO 类型

```typescript
// 用于 API 请求的 DTO
interface UpdateSessionDto {
  title?: string;
  status?: SessionStatus;
}
```

## 验收标准

- [ ] Shared Types 与后端 Schema 完全对齐
- [ ] 字段命名统一
- [ ] 创建对应的 DTO 类型
- [ ] 前端使用正确的 DTO 类型

## 优先级

**P2 - 中优先级** - 类型安全问题

## 相关文件

- `packages/shared-types/src/agent.ts`
- `packages/shared-types/src/session.ts`
- `apps/api/src/routes/v1/agents.ts`
- `apps/api/src/routes/v1/sessions.ts`
- `apps/api/src/routes/v1/chat.ts`
