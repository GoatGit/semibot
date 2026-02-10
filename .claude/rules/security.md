# 安全规范

## 多租户隔离

**所有数据查询必须包含 `org_id` 过滤条件。**

```typescript
// ✅ 正确 - 包含租户隔离
const agents = await db.query(
  'SELECT * FROM agents WHERE org_id = $1 AND deleted_at IS NULL',
  [orgId]
);

// ❌ 错误 - 缺少租户隔离
const agents = await db.query('SELECT * FROM agents WHERE deleted_at IS NULL');
```

### 安全警告日志

未提供 `org_id` 时必须打印警告：

```typescript
if (!orgId) {
  logger.warn('[Security] 查询未提供 org_id，存在跨租户风险', { method: 'search' });
}
```

### 公开资源访问

```typescript
// 公开资源需验证 is_public 标志
const agent = await db.query(
  'SELECT * FROM agents WHERE id = $1 AND (org_id = $2 OR is_public = true)',
  [agentId, orgId]
);
```

---

## 输入验证

### UUID 格式校验

```typescript
import { validate as uuidValidate } from 'uuid';

function validateUuid(id: string): boolean {
  return uuidValidate(id);
}

// 在查询前验证
if (!validateUuid(agentId)) {
  throw createError(400, 'INVALID_UUID', '无效的 ID 格式');
}
```

### 内容非空校验

```typescript
if (!content || content.trim().length === 0) {
  throw createError(400, 'EMPTY_CONTENT', '内容不能为空');
}
```

---

## 限流

### Redis 分布式限流

```typescript
// ✅ 使用 Redis 存储（支持多实例）
const limiter = new RateLimiter({
  store: new RedisStore(redis),
  windowMs: 60 * 1000,
  max: 100,
});

// 认证接口独立限流
const authLimiter = new RateLimiter({
  store: new RedisStore(redis),
  windowMs: 60 * 1000,
  max: 5, // 更严格
});
```

### 响应头

```typescript
// 添加限流信息响应头
res.setHeader('X-RateLimit-Limit', limit);
res.setHeader('X-RateLimit-Remaining', remaining);
res.setHeader('X-RateLimit-Reset', resetTime);
```

### 降级策略

```typescript
// Redis 不可用时回退到内存
if (!redis.isConnected) {
  logger.warn('[RateLimit] Redis 不可用，回退到内存限流');
  return memoryLimiter.check(key);
}
```

---

## 执行上下文隔离

缓存 key、临时文件、内存命名空间必须按 `org_id` 隔离，防止跨租户数据泄漏。

---

## SSE 连接限制

```typescript
const SSE_MAX_CONNECTIONS_PER_USER = 5;
const SSE_MAX_CONNECTIONS_PER_ORG = 50;

// 检查连接数
if (userConnections >= SSE_MAX_CONNECTIONS_PER_USER) {
  logger.warn('[SSE] 用户连接数已达上限', { userId, current: userConnections, limit: SSE_MAX_CONNECTIONS_PER_USER });
  throw createError(429, 'TOO_MANY_CONNECTIONS', '连接数已达上限');
}
```
