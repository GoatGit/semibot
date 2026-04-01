/**
 * 限流中间件
 *
 * 用户级和组织级限流，使用内存滑动窗口算法
 */

import type { Response, NextFunction } from 'express'
import rateLimit from 'express-rate-limit'
import type { AuthRequest } from './auth.js'
import {
  RATE_LIMIT_PER_MINUTE_USER,
  RATE_LIMIT_WINDOW_MS,
} from '../constants/config.js'
import {
  RATE_LIMIT_EXCEEDED,
  RATE_LIMIT_USER,
  ERROR_MESSAGES,
} from '../constants/errorCodes.js'
import { rateLimitLogger } from '../lib/logger.js'

// ─── 类型 ─────────────────────────────────────────────────────────────────────

interface RateLimitInfo {
  limit: number
  current: number
  remaining: number
  resetTime: Date
}

// ─── 内存存储 ─────────────────────────────────────────────────────────────────

const userLimits = new Map<string, RateLimitInfo>()
const orgLimits = new Map<string, RateLimitInfo>()

// 每分钟清理过期记录
const rateLimitCleanupTimer = setInterval(() => {
  const now = new Date()
  for (const [key, info] of userLimits) {
    if (info.resetTime <= now) userLimits.delete(key)
  }
  for (const [key, info] of orgLimits) {
    if (info.resetTime <= now) orgLimits.delete(key)
  }
}, 60_000)
if (typeof rateLimitCleanupTimer.unref === 'function') {
  rateLimitCleanupTimer.unref()
}

// ─── 内存滑动窗口 ─────────────────────────────────────────────────────────────

function checkRateLimit(
  store: Map<string, RateLimitInfo>,
  key: string,
  limit: number,
  windowMs: number
): { allowed: boolean; info: RateLimitInfo } {
  const now = new Date()
  let info = store.get(key)

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

  if (info.current >= limit) {
    rateLimitLogger.warn('限流触发', { key, current: info.current, limit })
    return { allowed: false, info: { ...info, remaining: 0 } }
  }

  info.current += 1
  info.remaining = limit - info.current
  store.set(key, info)
  return { allowed: true, info }
}

// ─── 响应头 / 错误 ────────────────────────────────────────────────────────────

function setRateLimitHeaders(res: Response, info: RateLimitInfo): void {
  res.setHeader('X-RateLimit-Limit', info.limit)
  res.setHeader('X-RateLimit-Remaining', Math.max(0, info.remaining))
  res.setHeader('X-RateLimit-Reset', Math.ceil(info.resetTime.getTime() / 1000))
}

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

// ─── 中间件 ───────────────────────────────────────────────────────────────────

export async function userRateLimit(
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  const userId = req.user?.userId
  const key = userId
    ? `user:${userId}`
    : `ip:${req.ip ?? req.socket.remoteAddress ?? 'unknown'}`

  const { allowed, info } = checkRateLimit(userLimits, key, RATE_LIMIT_PER_MINUTE_USER, RATE_LIMIT_WINDOW_MS)
  setRateLimitHeaders(res, info)
  if (!allowed) { sendRateLimitError(res, RATE_LIMIT_USER, info); return }
  next()
}

export async function orgRateLimit(
  _req: AuthRequest,
  _res: Response,
  next: NextFunction
): Promise<void> {
  next()
}

export async function combinedRateLimit(
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  await userRateLimit(req, res, async (err) => {
    if (err) { next(err); return }
    if (res.headersSent) return
    await orgRateLimit(req, res, next)
  })
}

export async function authRateLimit(
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  const ip = req.ip ?? req.socket.remoteAddress ?? 'unknown'
  const { allowed, info } = checkRateLimit(userLimits, `auth:${ip}`, 5, RATE_LIMIT_WINDOW_MS)
  setRateLimitHeaders(res, info)
  if (!allowed) {
    rateLimitLogger.warn('认证接口限流触发', { ip })
    sendRateLimitError(res, RATE_LIMIT_USER, info)
    return
  }
  next()
}

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

    const { allowed, info } = checkRateLimit(store, key, limit, windowMs)
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
