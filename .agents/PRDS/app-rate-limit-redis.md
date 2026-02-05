# PRD: Rate Limit Redis 改造

## 概述

当前 rate limit 使用内存 Map 存储，在多实例部署时会失效，需要改造为 Redis 存储。

## 问题描述

```typescript
// middleware/rateLimit.ts:34
const rateLimitStore = new Map<string, RateLimitEntry>()
// 注释: 生产环境应使用 Redis
```

**问题：**
- 多实例部署时每个实例有独立计数器
- 用户可通过请求不同实例绕过限流
- 实例重启后计数器丢失

## 目标

1. 使用 Redis 作为 rate limit 存储
2. 支持分布式部署
3. 保持现有 API 兼容

## 技术方案

### 1. Redis Rate Limiter

```typescript
// middleware/rateLimit.ts
import { redis } from '@/lib/redis'
import { RATE_LIMIT_CONFIG } from '@/constants/config'

interface RateLimitResult {
  allowed: boolean
  remaining: number
  resetAt: number
}

export async function checkRateLimit(
  key: string,
  limit: number,
  windowMs: number
): Promise<RateLimitResult> {
  const now = Date.now()
  const windowStart = now - windowMs
  const redisKey = `ratelimit:${key}`

  // 使用 Redis 有序集合实现滑动窗口
  const multi = redis.multi()

  // 移除过期记录
  multi.zremrangebyscore(redisKey, 0, windowStart)

  // 获取当前窗口内的请求数
  multi.zcard(redisKey)

  // 添加当前请求
  multi.zadd(redisKey, now, `${now}-${Math.random()}`)

  // 设置过期时间
  multi.pexpire(redisKey, windowMs)

  const results = await multi.exec()
  const count = results[1][1] as number

  if (count >= limit) {
    console.warn(
      `[RateLimit] 请求被限制 (key: ${key}, count: ${count}, limit: ${limit})`
    )
    return {
      allowed: false,
      remaining: 0,
      resetAt: now + windowMs,
    }
  }

  return {
    allowed: true,
    remaining: limit - count - 1,
    resetAt: now + windowMs,
  }
}

export function createRateLimiter(options: RateLimitOptions) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const key = options.keyGenerator(req)
    const result = await checkRateLimit(key, options.limit, options.windowMs)

    res.setHeader('X-RateLimit-Limit', options.limit)
    res.setHeader('X-RateLimit-Remaining', result.remaining)
    res.setHeader('X-RateLimit-Reset', result.resetAt)

    if (!result.allowed) {
      return res.status(429).json({
        success: false,
        error: {
          code: 'RATE_LIMIT_EXCEEDED',
          message: '请求过于频繁，请稍后重试',
        },
      })
    }

    next()
  }
}
```

### 2. 认证接口限流

```typescript
// routes/v1/auth.ts
import { createRateLimiter } from '@/middleware/rateLimit'

const authRateLimiter = createRateLimiter({
  limit: 5,           // 5 次
  windowMs: 60000,    // 1 分钟
  keyGenerator: (req) => `auth:${req.ip}`,
})

router.post('/login', authRateLimiter, authController.login)
router.post('/register', authRateLimiter, authController.register)
```

### 3. 回退机制

```typescript
// 当 Redis 不可用时回退到内存存储
export async function checkRateLimitWithFallback(
  key: string,
  limit: number,
  windowMs: number
): Promise<RateLimitResult> {
  try {
    return await checkRateLimit(key, limit, windowMs)
  } catch (error) {
    console.error('[RateLimit] Redis 不可用，使用内存回退', error)
    return checkRateLimitInMemory(key, limit, windowMs)
  }
}
```

## 验收标准

- [ ] Rate limit 使用 Redis 存储
- [ ] 多实例部署时限流正确
- [ ] 认证接口有独立限流规则
- [ ] Redis 不可用时优雅降级
- [ ] 单元测试覆盖率 > 80%

## 优先级

**P1 - 高优先级** - 生产环境必需

## 相关文件

- `apps/api/src/middleware/rateLimit.ts`
- `apps/api/src/lib/redis.ts`
- `apps/api/src/routes/v1/auth.ts`
