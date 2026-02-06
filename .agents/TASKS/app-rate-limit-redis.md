## Task: Rate Limit Redis 改造

**ID:** app-rate-limit-redis
**Label:** Semibot: Rate Limit 改用 Redis 存储
**Description:** 将 rate limit 从内存 Map 改为 Redis，支持分布式部署
**Type:** Enhancement
**Status:** Completed
**Priority:** P1 - High
**Created:** 2026-02-06
**Updated:** 2026-02-06
**PRD:** [Link](../PRDS/app-rate-limit-redis.md)

---

### Checklist

- [ ] 确保 `lib/redis.ts` 已创建 (依赖 app-queue-service)
- [ ] 实现 Redis 滑动窗口限流算法
- [ ] 修改 `rateLimit.ts` 使用 Redis
- [ ] 添加认证接口独立限流规则 (5次/分钟)
- [ ] 实现 Redis 不可用时的内存回退
- [ ] 添加 X-RateLimit-* 响应头
- [ ] 编写单元测试
- [ ] 多实例部署测试

### 相关文件

- `apps/api/src/middleware/rateLimit.ts`
- `apps/api/src/lib/redis.ts`
- `apps/api/src/routes/v1/auth.ts`
- `apps/api/src/__tests__/rateLimit.test.ts`
