/**
 * Skill Retry Service
 *
 * 处理技能包的重试逻辑（已移除版本回滚功能）
 */

import { createError } from '../middleware/errorHandler'
import {
  SKILL_DEFAULT_MAX_RETRIES,
  SKILL_DEFAULT_RETRY_DELAY_MS,
} from '../constants/config'
import * as skillInstallService from './skill-install.service'

// ═══════════════════════════════════════════════════════════════
// 类型定义
// ═══════════════════════════════════════════════════════════════

export interface RetryOptions {
  maxRetries?: number
  retryDelay?: number
}

// ═══════════════════════════════════════════════════════════════
// 重试逻辑
// ═══════════════════════════════════════════════════════════════

/**
 * 判断错误是否可重试
 */
function isRetryableError(error: any): boolean {
  const retryableCodes = [
    'ECONNRESET',
    'ETIMEDOUT',
    'ENOTFOUND',
    'ENETUNREACH',
    'EAI_AGAIN',
  ]

  return (!!error.code && retryableCodes.includes(error.code)) || (error.message?.includes('network') ?? false)
}

/**
 * 计算指数退避延迟
 */
function calculateBackoffDelay(attempt: number, baseDelay: number): number {
  return baseDelay * Math.pow(2, attempt - 1)
}

/**
 * 带重试的安装
 */
export async function installWithRetry(
  input: skillInstallService.InstallSkillPackageInput,
  maxRetries: number = SKILL_DEFAULT_MAX_RETRIES
): Promise<string> {
  let lastError: any

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await skillInstallService.installSkillPackage(input)
    } catch (error: any) {
      lastError = error

      if (!isRetryableError(error)) {
        throw error
      }

      if (attempt >= maxRetries) {
        throw createError(
          'INSTALL_FAILED_AFTER_RETRIES',
          `安装失败，已重试 ${maxRetries} 次: ${(error as Error).message}`
        )
      }

      const delay = calculateBackoffDelay(attempt, SKILL_DEFAULT_RETRY_DELAY_MS)
      await new Promise((resolve) => setTimeout(resolve, delay))
    }
  }

  throw lastError
}
