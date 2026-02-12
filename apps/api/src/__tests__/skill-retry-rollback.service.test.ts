/**
 * Skill Retry Service 单元测试 (无版本回滚，仅重试)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as skillRetryRollbackService from '../services/skill-retry-rollback.service'
import * as skillInstallService from '../services/skill-install.service'

// Mock dependencies
vi.mock('../services/skill-install.service')
vi.mock('../lib/logger', () => ({
  createLogger: vi.fn().mockReturnValue({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}))

describe('Skill Retry Service', () => {
  const mockDefinitionId = 'def-123'
  const mockPackageId = 'pkg-123'

  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('installWithRetry', () => {
    it('应该在第一次尝试成功时不重试', async () => {
      ;(skillInstallService.installSkillPackage as vi.Mock).mockResolvedValue(mockPackageId)

      const input = {
        skillDefinitionId: mockDefinitionId,
        sourceType: 'local' as const,
        localPath: '/tmp/test-skill',
      }

      const result = await skillRetryRollbackService.installWithRetry(input)

      expect(result).toBe(mockPackageId)
      expect(skillInstallService.installSkillPackage).toHaveBeenCalledTimes(1)
    })

    it('应该在可重试错误时重试', async () => {
      const retryableError = new Error('ECONNRESET')
      ;(retryableError as any).code = 'ECONNRESET'

      ;(skillInstallService.installSkillPackage as vi.Mock)
        .mockRejectedValueOnce(retryableError)
        .mockRejectedValueOnce(retryableError)
        .mockResolvedValue(mockPackageId)

      const input = {
        skillDefinitionId: mockDefinitionId,
        sourceType: 'local' as const,
        localPath: '/tmp/test-skill',
      }

      const result = await skillRetryRollbackService.installWithRetry(input, 3)

      expect(result).toBe(mockPackageId)
      expect(skillInstallService.installSkillPackage).toHaveBeenCalledTimes(3)
    })

    it('应该在达到最大重试次数后失败', async () => {
      const retryableError = new Error('ETIMEDOUT')
      ;(retryableError as any).code = 'ETIMEDOUT'

      ;(skillInstallService.installSkillPackage as vi.Mock).mockRejectedValue(retryableError)

      const input = {
        skillDefinitionId: mockDefinitionId,
        sourceType: 'local' as const,
        localPath: '/tmp/test-skill',
      }

      await expect(
        skillRetryRollbackService.installWithRetry(input, 2)
      ).rejects.toThrow('安装失败，已重试')

      expect(skillInstallService.installSkillPackage).toHaveBeenCalledTimes(2)
    })

    it('应该在不可重试错误时立即失败', async () => {
      const nonRetryableError = new Error('Invalid SKILL.md')

      ;(skillInstallService.installSkillPackage as vi.Mock).mockRejectedValue(nonRetryableError)

      const input = {
        skillDefinitionId: mockDefinitionId,
        sourceType: 'local' as const,
        localPath: '/tmp/test-skill',
      }

      await expect(
        skillRetryRollbackService.installWithRetry(input, 3)
      ).rejects.toThrow('Invalid SKILL.md')

      expect(skillInstallService.installSkillPackage).toHaveBeenCalledTimes(1)
    })

    it('应该使用指数退避', async () => {
      const retryableError = new Error('network error')

      ;(skillInstallService.installSkillPackage as vi.Mock)
        .mockRejectedValueOnce(retryableError)
        .mockResolvedValue(mockPackageId)

      const startTime = Date.now()

      const input = {
        skillDefinitionId: mockDefinitionId,
        sourceType: 'local' as const,
        localPath: '/tmp/test-skill',
      }

      await skillRetryRollbackService.installWithRetry(input, 2)

      const duration = Date.now() - startTime

      // 应该至少等待 1 秒（第一次重试的退避时间）
      expect(duration).toBeGreaterThanOrEqual(1000)
    }, 10000)
  })
})
