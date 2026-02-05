/**
 * 限流中间件
 *
 * 支持用户级和组织级限流
 */

import type { Response, NextFunction } from 'express'
import rateLimit from 'express-rate-limit'
import type { AuthRequest } from './auth.js'
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
// 限流存储 (内存实现，生产环境应使用 Redis)
// ═══════════════════════════════════════════════════════════════

const userLimits = new Map<string, RateLimitInfo>()
const orgLimits = new Map<string, RateLimitInfo>()

/**
 * 清理过期的限流记录
 */
function cleanupExpiredLimits(): void {
  const now = new Date()

  for (const [key, info] of userLimits) {
    if (info.resetTime <= now) {
      userLimits.delete(key)
    }
  }

  for (const [key, info] of orgLimits) {
    if (info.resetTime <= now) {
      orgLimits.delete(key)
    }
  }
}

// 每分钟清理一次
setInterval(cleanupExpiredLimits, 60000)

/**
 * 检查并更新限流状态
 */
function checkAndUpdateLimit(
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
    console.warn(
      `[RateLimit] 限流触发 - Key: ${key}, 当前: ${info.current}, 限制: ${limit}`
    )
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

// ═══════════════════════════════════════════════════════════════
// 中间件
// ═══════════════════════════════════════════════════════════════

/**
 * 用户级限流中间件
 */
export function userRateLimit(req: AuthRequest, res: Response, next: NextFunction): void {
  const userId = req.user?.userId

  if (!userId) {
    // 未认证用户使用 IP 作为标识
    const ip = req.ip ?? req.socket.remoteAddress ?? 'unknown'
    const { allowed, info } = checkAndUpdateLimit(
      userLimits,
      `ip:${ip}`,
      RATE_LIMIT_PER_MINUTE_USER,
      RATE_LIMIT_WINDOW_MS
    )

    setRateLimitHeaders(res, info)

    if (!allowed) {
      sendRateLimitError(res, RATE_LIMIT_USER, info)
      return
    }

    next()
    return
  }

  const { allowed, info } = checkAndUpdateLimit(
    userLimits,
    `user:${userId}`,
    RATE_LIMIT_PER_MINUTE_USER,
    RATE_LIMIT_WINDOW_MS
  )

  setRateLimitHeaders(res, info)

  if (!allowed) {
    sendRateLimitError(res, RATE_LIMIT_USER, info)
    return
  }

  next()
}

/**
 * 组织级限流中间件
 */
export function orgRateLimit(req: AuthRequest, res: Response, next: NextFunction): void {
  const orgId = req.user?.orgId

  if (!orgId) {
    next()
    return
  }

  const { allowed, info } = checkAndUpdateLimit(
    orgLimits,
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
}

/**
 * 组合限流中间件 (先检查用户级，再检查组织级)
 */
export function combinedRateLimit(req: AuthRequest, res: Response, next: NextFunction): void {
  userRateLimit(req, res, (err) => {
    if (err) {
      next(err)
      return
    }

    // 如果响应已发送 (被限流)，不继续
    if (res.headersSent) {
      return
    }

    orgRateLimit(req, res, next)
  })
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
 *
 * @param limit 限制次数
 * @param windowMs 窗口大小 (毫秒)
 * @param keyGenerator 生成限流 key 的函数
 */
export function createRateLimit(options: {
  limit: number
  windowMs: number
  keyGenerator?: (req: AuthRequest) => string
  message?: string
}) {
  const { limit, windowMs, keyGenerator, message } = options
  const store = new Map<string, RateLimitInfo>()

  return (req: AuthRequest, res: Response, next: NextFunction): void => {
    const key = keyGenerator
      ? keyGenerator(req)
      : req.user?.userId ?? req.ip ?? 'anonymous'

    const { allowed, info } = checkAndUpdateLimit(store, key, limit, windowMs)

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
