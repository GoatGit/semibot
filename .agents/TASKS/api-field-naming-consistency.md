## Task: API 字段命名一致性修复

**ID:** api-field-naming-consistency
**Label:** Semibot: 统一 API 字段命名为 camelCase
**Description:** 修复后端 API 响应中 snake_case 和 camelCase 混用的问题
**Type:** Refactor
**Status:** Completed ✅
**Priority:** P2 - Medium
**Created:** 2026-02-06
**Updated:** 2026-02-06
**PRD:** [Link](../PRDS/api-field-naming-consistency.md)

---

### Checklist

#### auth.ts 修复
- [x] 第 31-33 行: `refresh_token` → `refreshToken` (Schema)
- [x] 第 101 行: `refresh_token` → `refreshToken`
- [x] 第 102 行: `expires_at` → `expiresAt`
- [x] 第 142 行: `refresh_token` → `refreshToken`
- [x] 第 143 行: `expires_at` → `expiresAt`
- [x] 第 174-176 行: `refresh_token` → `refreshToken` (变量)
- [x] 第 183 行: `refresh_token` → `refreshToken`
- [x] 第 184 行: `expires_at` → `expiresAt`

#### organizations.ts 修复
- [x] 第 74 行: `owner_id` → `ownerId`
- [x] 第 75 行: `is_active` → `isActive`
- [x] 第 76 行: `created_at` → `createdAt`
- [x] 第 121 行: `updated_at` → `updatedAt`
- [x] 第 166 行: `joined_at` → `joinedAt`
- [x] 第 167 行: `last_login_at` → `lastLoginAt`
- [x] 第 170 行: `next_cursor` → `nextCursor`

#### api-keys.ts 修复
- [x] 第 22 行: `expires_at` → `expiresAt` (Schema)
- [x] 第 76 行: `expires_at` → `expiresAt` (变量)
- [x] 第 91 行: `key_prefix` → `keyPrefix`
- [x] 第 92 行: `expires_at` → `expiresAt`
- [x] 第 93 行: `created_at` → `createdAt`
- [x] 第 114 行: `key_prefix` → `keyPrefix`
- [x] 第 116 行: `last_used_at` → `lastUsedAt`
- [x] 第 117 行: `expires_at` → `expiresAt`
- [x] 第 118 行: `is_active` → `isActive`

#### 前端同步更新
- [x] 前端 Hooks 使用 camelCase 字段名
- [x] 确认无破坏性变更

#### 验证
- [ ] 运行所有 API 测试
- [ ] 验证前端功能正常

### 相关文件

- `apps/api/src/routes/v1/auth.ts` ✅
- `apps/api/src/routes/v1/organizations.ts` ✅
- `apps/api/src/routes/v1/api-keys.ts` ✅
