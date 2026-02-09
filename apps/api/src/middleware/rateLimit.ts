/**
 * 限流中间件
 *
 * 支持用户级和组织级限流，使用 Redis 滑动窗口算法
 * 支持 Redis 不可用时自动回退到内存存储
 */

import type { Response, NextFunction } from 'express'
import rateLimit from 'express-rate-limit'
import type { AuthRequest } from './auth.js'
import * as redis from '../lib/redis.js'
import {
  RATE_LIMIT_PER_MINUTE_USER,
  RATE_LIMIT_PER_MINUTE_ORG,
  RATE_LIMIT_WINDOW_MS,
} from '../constants/config.js'
import {
  RATE_LIMIT_EXCEEDED,
  RATE_LIMIT_USER,
  RATE_LIMIT_ORG,
  ERROR_MESSAGES,
} from '../constants/errorCodes.js'
import { rateLimitLogger } from '../lib/logger.js'

// ═══════════════════════════════════════════════════════════════
// 类型定义
// ═══════════════════════════════════════════════════════════════

interface RateLimitInfo {
  limit: number
  current: number
  remaining: number
  resetTime: Date
}

// ═══════════════════════════════════════════════════════════════
// Redis 键名前缀
// ═══════════════════════════════════════════════════════════════

const RATE_LIMIT_PREFIX = 'semibot:ratelimit:'

// ═══════════════════════════════════════════════════════════════
// 内存回退存储 (当 Redis 不可用时使用)
// ═══════════════════════════════════════════════════════════════

const userLimitsFallback = new Map<string, RateLimitInfo>()
const orgLimitsFallback = new Map<string, RateLimitInfo>()

/**
 * 清理过期的限流记录 (内存回退)
 */
function cleanupExpiredLimits(): void {
  const now = new Date()

  for (const [key, info] of userLimitsFallback) {
    if (info.resetTime <= now) {
      userLimitsFallback.delete(key)
    }
  }

  for (const [key, info] of orgLimitsFallback) {
    if (info.resetTime <= now) {
      orgLimitsFallback.delete(key)
    }
  }
}

// 每分钟清理一次
setInterval(cleanupExpiredLimits, 60000)

// ═══════════════════════════════════════════════════════════════
// Redis 滑动窗口限流实现
// ═══════════════════════════════════════════════════════════════

/**
 * 使用 Redis 滑动窗口检查限流
 */
async function checkRateLimitRedis(
  key: string,
  limit: number,
  windowMs: number
): Promise<{ allowed: boolean; info: RateLimitInfo }> {
  const redisKey = `${RATE_LIMIT_PREFIX}${key}`
  const now = Date.now()
  const windowStart = now - windowMs

  try {
    const client = redis.getRedisClient()

    // 使用 Redis pipeline 执行滑动窗口算法
    const pipeline = client.pipeline()

    // 1. 移除过期的请求记录
    pipeline.zremrangebyscore(redisKey, 0, windowStart)

    // 2. 添加当前请求
    pipeline.zadd(redisKey, now, `${now}:${Math.random()}`)

    // 3. 获取当前窗口内的请求数
    pipeline.zcard(redisKey)

    // 4. 设置过期时间 (防止键永久存在)
    pipeline.pexpire(redisKey, windowMs)

    const results = await pipeline.exec()

    if (!results) {
      throw new Error('Pipeline execution failed')
    }

    // 获取当前请求数
    const current = results[2][1] as number
    const allowed = current <= limit
    const resetTime = new Date(now + windowMs)

    const info: RateLimitInfo = {
      limit,
      current,
      remaining: Math.max(0, limit - current),
      resetTime,
    }

    if (!allowed) {
      rateLimitLogger.warn('Redis 限流触发', { key, current, limit })
    }

    return { allowed, info }
  } catch (error) {
    rateLimitLogger.error('Redis 操作失败，使用内存回退', error as Error)
    throw error
  }
}

/**
 * 使用内存回退检查限流
 */
function checkRateLimitMemory(
  store: Map<string, RateLimitInfo>,
  key: string,
  limit: number,
  windowMs: number
): { allowed: boolean; info: RateLimitInfo } {
  const now = new Date()
  let info = store.get(key)

  // 如果没有记录或已过期，创建新记录
  if (!info || info.resetTime <= now) {
    info = {
      limit,
      current: 1,
      remaining: limit - 1,
      resetTime: new Date(now.getTime() + windowMs),
    }
    store.set(key, info)
    return { allowed: true, info }
  }

  // 检查是否超限
  if (info.current >= limit) {
    rateLimitLogger.warn('内存限流触发', { key, current: info.current, limit })
    return {
      allowed: false,
      info: { ...info, remaining: 0 },
    }
  }

  // 更新计数
  info.current += 1
  info.remaining = limit - info.current
  store.set(key, info)

  return { allowed: true, info }
}

/**
 * 检查限流 (优先使用 Redis，失败时回退到内存)
 */
async function checkRateLimit(
  fallbackStore: Map<string, RateLimitInfo>,
  key: string,
  limit: number,
  windowMs: number
): Promise<{ allowed: boolean; info: RateLimitInfo }> {
  // 先尝试 Redis
  if (redis.isRedisConnected()) {
    try {
      return await checkRateLimitRedis(key, limit, windowMs)
    } catch {
      // Redis 失败，使用内存回退
    }
  }

  // 内存回退
  return checkRateLimitMemory(fallbackStore, key, limit, windowMs)
}

// ═══════════════════════════════════════════════════════════════
// 中间件
// ═══════════════════════════════════════════════════════════════

/**
 * 用户级限流中间件
 */
export async function userRateLimit(
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  const userId = req.user?.userId

  let key: string
  if (!userId) {
    // 未认证用户使用 IP 作为标识
    const ip = req.ip ?? req.socket.remoteAddress ?? 'unknown'
    key = `ip:${ip}`
  } else {
    key = `user:${userId}`
  }

  try {
    const { allowed, info } = await checkRateLimit(
      userLimitsFallback,
      key,
      RATE_LIMIT_PER_MINUTE_USER,
      RATE_LIMIT_WINDOW_MS
    )

    setRateLimitHeaders(res, info)

    if (!allowed) {
      sendRateLimitError(res, RATE_LIMIT_USER, info)
      return
    }

    next()
  } catch (error) {
    rateLimitLogger.error('用户限流检查失败', error as Error)
    // 限流检查失败时，允许请求通过 (fail-open)
    next()
  }
}

/**
 * 组织级限流中间件
 */
export async function orgRateLimit(
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  const orgId = req.user?.orgId

  if (!orgId) {
    next()
    return
  }

  try {
    const { allowed, info } = await checkRateLimit(
      orgLimitsFallback,
      `org:${orgId}`,
      RATE_LIMIT_PER_MINUTE_ORG,
      RATE_LIMIT_WINDOW_MS
    )

    setRateLimitHeaders(res, info)

    if (!allowed) {
      sendRateLimitError(res, RATE_LIMIT_ORG, info)
      return
    }

    next()
  } catch (error) {
    rateLimitLogger.error('组织限流检查失败', error as Error)
    next()
  }
}

/**
 * 组合限流中间件 (先检查用户级，再检查组织级)
 */
export async function combinedRateLimit(
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  // 用户级限流
  await userRateLimit(req, res, async (err) => {
    if (err) {
      next(err)
      return
    }

    // 如果响应已发送 (被限流)，不继续
    if (res.headersSent) {
      return
    }

    // 组织级限流
    await orgRateLimit(req, res, next)
  })
}

/**
 * 认证接口专用限流 (更严格: 5次/分钟)
 */
export async function authRateLimit(
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  const ip = req.ip ?? req.socket.remoteAddress ?? 'unknown'
  const key = `auth:${ip}`
  const AUTH_RATE_LIMIT = 5 // 5次/分钟

  try {
    const { allowed, info } = await checkRateLimit(
      userLimitsFallback,
      key,
      AUTH_RATE_LIMIT,
      RATE_LIMIT_WINDOW_MS
    )

    setRateLimitHeaders(res, info)

    if (!allowed) {
      rateLimitLogger.warn('认证接口限流触发', { ip })
      sendRateLimitError(res, RATE_LIMIT_USER, info)
      return
    }

    next()
  } catch (error) {
    rateLimitLogger.error('认证限流检查失败', error as Error)
    next()
  }
}

/**
 * 设置限流响应头
 */
function setRateLimitHeaders(res: Response, info: RateLimitInfo): void {
  res.setHeader('X-RateLimit-Limit', info.limit)
  res.setHeader('X-RateLimit-Remaining', Math.max(0, info.remaining))
  res.setHeader('X-RateLimit-Reset', Math.ceil(info.resetTime.getTime() / 1000))
}

/**
 * 发送限流错误响应
 */
function sendRateLimitError(res: Response, code: string, info: RateLimitInfo): void {
  const retryAfter = Math.ceil((info.resetTime.getTime() - Date.now()) / 1000)

  res.setHeader('Retry-After', retryAfter)
  res.status(429).json({
    success: false,
    error: {
      code,
      message: ERROR_MESSAGES[code] ?? ERROR_MESSAGES[RATE_LIMIT_EXCEEDED],
      retryAfter,
    },
  })
}

/**
 * 创建自定义限流中间件
 */
export function createRateLimit(options: {
  limit: number
  windowMs: number
  keyGenerator?: (req: AuthRequest) => string
  message?: string
}) {
  const { limit, windowMs, keyGenerator, message } = options
  const store = new Map<string, RateLimitInfo>()

  return async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
    const key = keyGenerator
      ? keyGenerator(req)
      : req.user?.userId ?? req.ip ?? 'anonymous'

    try {
      const { allowed, info } = await checkRateLimit(store, key, limit, windowMs)

      setRateLimitHeaders(res, info)

      if (!allowed) {
        const retryAfter = Math.ceil((info.resetTime.getTime() - Date.now()) / 1000)
        res.setHeader('Retry-After', retryAfter)
        res.status(429).json({
          success: false,
          error: {
            code: RATE_LIMIT_EXCEEDED,
            message: message ?? ERROR_MESSAGES[RATE_LIMIT_EXCEEDED],
            retryAfter,
          },
        })
        return
      }

      next()
    } catch (error) {
      rateLimitLogger.error('自定义限流检查失败', error as Error)
      next()
    }
  }
}

/**
 * 基于 express-rate-limit 的通用限流 (用于简单场景)
 */
export const generalRateLimit = rateLimit({
  windowMs: RATE_LIMIT_WINDOW_MS,
  limit: RATE_LIMIT_PER_MINUTE_USER,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: {
    success: false,
    error: {
      code: RATE_LIMIT_EXCEEDED,
      message: ERROR_MESSAGES[RATE_LIMIT_EXCEEDED],
    },
  },
})
