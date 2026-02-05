## Task: Token 黑名单功能

**ID:** app-auth-token-blacklist
**Label:** Semibot: 实现 Token 黑名单机制
**Description:** 完成 auth.service.ts 中 Token 黑名单功能，支持登出后立即失效
**Type:** Feature
**Status:** Pending
**Priority:** P2 - Medium
**Created:** 2026-02-06
**Updated:** 2026-02-06
**PRD:** N/A

---

### Checklist

- [ ] 确保 Redis 客户端已配置 (依赖 app-queue-service)
- [ ] 实现 `addToBlacklist(token, expiry)` 方法
- [ ] 实现 `isBlacklisted(token)` 方法
- [ ] 在 `logout()` 中添加 token 到黑名单
- [ ] 在 `auth.middleware.ts` 中检查黑名单
- [ ] 设置黑名单 TTL = token 剩余有效期
- [ ] 移除 TODO 注释 (第 357 行)
- [ ] 编写单元测试

### 相关文件

- `apps/api/src/services/auth.service.ts` (第 357 行)
- `apps/api/src/middleware/auth.ts`
- `apps/api/src/lib/redis.ts`
