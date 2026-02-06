/**
 * Logger 日志工具
 *
 * 提供统一的日志输出，支持开发/生产环境不同配置
 */

import pino from 'pino'
import { LOG_LEVEL } from '../constants/config'

// ═══════════════════════════════════════════════════════════════
// Logger 配置
// ═══════════════════════════════════════════════════════════════

const isDevelopment = process.env.NODE_ENV !== 'production'

/**
 * 创建 Pino logger 实例
 */
const pinoLogger = pino({
  level: LOG_LEVEL,
  transport: isDevelopment
    ? {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'SYS:standard',
          ignore: 'pid,hostname',
        },
      }
    : undefined,
  formatters: {
    level: (label) => ({ level: label }),
  },
  base: {
    env: process.env.NODE_ENV,
  },
})

// ═══════════════════════════════════════════════════════════════
// Logger 封装
// ═══════════════════════════════════════════════════════════════

export interface LogContext {
  module?: string
  userId?: string
  orgId?: string
  sessionId?: string
  requestId?: string
  [key: string]: unknown
}

/**
 * 创建带有上下文的 logger
 */
export function createLogger(module: string) {
  const child = pinoLogger.child({ module })

  return {
    /**
     * 调试日志
     */
    debug(message: string, context?: LogContext): void {
      child.debug(context, message)
    },

    /**
     * 信息日志
     */
    info(message: string, context?: LogContext): void {
      child.info(context, message)
    },

    /**
     * 警告日志
     */
    warn(message: string, context?: LogContext): void {
      child.warn(context, message)
    },

    /**
     * 错误日志
     */
    error(message: string, error?: Error | unknown, context?: LogContext): void {
      if (error instanceof Error) {
        child.error({ ...context, err: error }, message)
      } else if (error) {
        child.error({ ...context, error }, message)
      } else {
        child.error(context, message)
      }
    },

    /**
     * 严重错误日志
     */
    fatal(message: string, error?: Error | unknown, context?: LogContext): void {
      if (error instanceof Error) {
        child.fatal({ ...context, err: error }, message)
      } else if (error) {
        child.fatal({ ...context, error }, message)
      } else {
        child.fatal(context, message)
      }
    },
  }
}

// ═══════════════════════════════════════════════════════════════
// 默认 logger 实例
// ═══════════════════════════════════════════════════════════════

export const logger = createLogger('app')

// ═══════════════════════════════════════════════════════════════
// 模块级 logger
// ═══════════════════════════════════════════════════════════════

export const authLogger = createLogger('auth')
export const apiKeysLogger = createLogger('api-keys')
export const agentLogger = createLogger('agent')
export const sessionLogger = createLogger('session')
export const chatLogger = createLogger('chat')
export const mcpLogger = createLogger('mcp')
export const queueLogger = createLogger('queue')
export const rateLimitLogger = createLogger('rate-limit')

export default logger
