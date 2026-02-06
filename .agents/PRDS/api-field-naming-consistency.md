# PRD: API 字段命名一致性

## 概述

后端 API 响应中存在字段命名风格不一致的问题，部分使用 snake_case，部分使用 camelCase。

## 问题描述

### 不一致的字段命名

| 文件 | 行号 | 字段 | 当前风格 |
|------|-----|------|---------|
| `auth.ts` | 101-103 | `refresh_token`, `expires_at` | snake_case |
| `organizations.ts` | 74-77 | `owner_id`, `is_active`, `created_at` | snake_case |
| `api-keys.ts` | 91-93 | `key_prefix`, `expires_at`, `created_at` | snake_case |
| `api-keys.ts` | 114-118 | `last_used_at`, `is_active` | snake_case |
| `organizations.ts` | 166-167 | `joined_at`, `last_login_at` | snake_case |

### 使用 camelCase 的接口（正确）

- `agents.ts` - 全部使用 camelCase
- `sessions.ts` - 全部使用 camelCase
- `chat.ts` - 全部使用 camelCase
- `skills.ts` - 全部使用 camelCase
- `tools.ts` - 全部使用 camelCase
- `mcp.ts` - 全部使用 camelCase
- `memory.ts` - 全部使用 camelCase

## 目标

1. 统一所有 API 响应字段使用 camelCase
2. 确保前后端类型定义一致
3. 更新相关文档

## 技术方案

### 1. 修改 auth.ts

```typescript
// Before
res.json({
  data: {
    refresh_token: result.refreshToken,
    expires_at: result.expiresAt,
  }
})

// After
res.json({
  data: {
    refreshToken: result.refreshToken,
    expiresAt: result.expiresAt,
  }
})
```

### 2. 修改 organizations.ts

```typescript
// Before
data: {
  owner_id: org.ownerId,
  is_active: org.isActive,
  created_at: org.createdAt,
}

// After
data: {
  ownerId: org.ownerId,
  isActive: org.isActive,
  createdAt: org.createdAt,
}
```

### 3. 修改 api-keys.ts

统一使用 camelCase：`keyPrefix`, `expiresAt`, `createdAt`, `lastUsedAt`, `isActive`

## 验收标准

- [ ] 所有 API 响应字段使用 camelCase
- [ ] 前端类型定义同步更新
- [ ] API 文档更新
- [ ] 无破坏性变更（需评估现有调用方）

## 优先级

**P2 - 中优先级** - 影响代码一致性和维护性

## 相关文件

- `apps/api/src/routes/v1/auth.ts`
- `apps/api/src/routes/v1/organizations.ts`
- `apps/api/src/routes/v1/api-keys.ts`
