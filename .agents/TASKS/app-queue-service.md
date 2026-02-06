## Task: Queue Service 实现

**ID:** app-queue-service
**Label:** Semibot: 实现 Queue Service Redis 集成
**Description:** 完成 queue.service.ts 中的 6 个 TODO，实现 Redis Stream 队列
**Type:** Feature
**Status:** Completed
**Priority:** P1 - High
**Created:** 2026-02-06
**Updated:** 2026-02-06
**PRD:** [Link](../PRDS/app-queue-service.md)

---

### Checklist

- [ ] 创建 `lib/redis.ts` Redis 客户端配置
- [ ] 添加 Redis 环境变量配置
- [ ] 实现 `enqueue()` - Redis XADD
- [ ] 实现 `dequeue()` - Redis XREADGROUP
- [ ] 实现 `acknowledge()` - Redis XACK
- [ ] 实现 `publish()` - Redis PUBLISH
- [ ] 实现 `getQueueLength()` - Redis XLEN
- [ ] 实现 `healthCheck()` - Redis PING
- [ ] 添加队列名称常量配置
- [ ] 添加消费者组常量配置
- [ ] 编写单元测试 (mock Redis)
- [ ] 编写集成测试 (真实 Redis)

### 相关文件

- `apps/api/src/services/queue.service.ts`
- `apps/api/src/lib/redis.ts` (新建)
- `apps/api/src/constants/config.ts`
- `apps/api/src/__tests__/queue.service.test.ts`
