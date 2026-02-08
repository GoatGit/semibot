/**
 * Skill Retry and Rollback Service 单元测试
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as skillRetryRollbackService from '../services/skill-retry-rollback.service'
import * as skillDefinitionRepo from '../repositories/skill-definition.repository'
import * as skillPackageRepo from '../repositories/skill-package.repository'
import * as skillInstallLogRepo from '../repositories/skill-install-log.repository'
import * as skillInstallService from '../services/skill-install.service'

// Mock dependencies
vi.mock('../repositories/skill-definition.repository')
vi.mock('../repositories/skill-package.repository')
vi.mock('../repositories/skill-install-log.repository')
vi.mock('../services/skill-install.service')
vi.mock('fs-extra')

describe('Skill Retry and Rollback Service', () => {
  const mockUserId = 'user-123'
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
        version: '1.0.0',
        sourceType: 'anthropic' as const,
      }

      const result = await skillRetryRollbackService.installWithRetry(mockUserId, input)

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
        version: '1.0.0',
        sourceType: 'anthropic' as const,
      }

      const result = await skillRetryRollbackService.installWithRetry(mockUserId, input, 3)

      expect(result).toBe(mockPackageId)
      expect(skillInstallService.installSkillPackage).toHaveBeenCalledTimes(3)
    })

    it('应该在达到最大重试次数后失败', async () => {
      const retryableError = new Error('ETIMEDOUT')
      ;(retryableError as any).code = 'ETIMEDOUT'

      ;(skillInstallService.installSkillPackage as vi.Mock).mockRejectedValue(retryableError)

      const input = {
        skillDefinitionId: mockDefinitionId,
        version: '1.0.0',
        sourceType: 'anthropic' as const,
      }

      await expect(
        skillRetryRollbackService.installWithRetry(mockUserId, input, 2)
      ).rejects.toThrow('安装失败，已重试')

      expect(skillInstallService.installSkillPackage).toHaveBeenCalledTimes(3) // 初始 + 2 次重试
    })

    it('应该在不可重试错误时立即失败', async () => {
      const nonRetryableError = new Error('Invalid manifest')

      ;(skillInstallService.installSkillPackage as vi.Mock).mockRejectedValue(nonRetryableError)

      const input = {
        skillDefinitionId: mockDefinitionId,
        version: '1.0.0',
        sourceType: 'anthropic' as const,
      }

      await expect(
        skillRetryRollbackService.installWithRetry(mockUserId, input, 3)
      ).rejects.toThrow('Invalid manifest')

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
        version: '1.0.0',
        sourceType: 'anthropic' as const,
      }

      await skillRetryRollbackService.installWithRetry(mockUserId, input, 1)

      const duration = Date.now() - startTime

      // 应该至少等待 1 秒（第一次重试的退避时间）
      expect(duration).toBeGreaterThanOrEqual(1000)
    }, 10000)
  })

  describe('rollbackToVersion', () => {
    it('应该成功回滚到指定版本', async () => {
      const targetVersion = '1.0.0'
      const currentVersion = '2.0.0'

      ;(skillDefinitionRepo.findById as vi.Mock).mockResolvedValue({
        id: mockDefinitionId,
        currentVersion,
      })

      ;(skillPackageRepo.findByDefinitionAndVersion as vi.Mock)
        .mockResolvedValueOnce({
          id: 'target-pkg',
          version: targetVersion,
          status: 'active',
        })
        .mockResolvedValueOnce({
          id: 'current-pkg',
          version: currentVersion,
          status: 'active',
        })

      ;(skillInstallLogRepo.create as vi.Mock).mockResolvedValue({
        id: 'log-123',
        startedAt: new Date(),
      })

      ;(skillDefinitionRepo.update as vi.Mock).mockResolvedValue({})
      ;(skillPackageRepo.update as vi.Mock).mockResolvedValue({})
      ;(skillInstallLogRepo.update as vi.Mock).mockResolvedValue({})

      const result = await skillRetryRollbackService.rollbackToVersion(
        mockUserId,
        mockDefinitionId,
        targetVersion,
        'Bug in 2.0.0'
      )

      expect(result).toBe('target-pkg')
      expect(skillDefinitionRepo.update).toHaveBeenCalledWith(
        mockDefinitionId,
        expect.objectContaining({
          currentVersion: targetVersion,
        })
      )
    })

    it('应该拒绝不存在的技能定义', async () => {
      ;(skillDefinitionRepo.findById as vi.Mock).mockResolvedValue(null)

      await expect(
        skillRetryRollbackService.rollbackToVersion(mockUserId, mockDefinitionId, '1.0.0')
      ).rejects.toThrow('技能定义不存在')
    })

    it('应该拒绝不存在的目标版本', async () => {
      ;(skillDefinitionRepo.findById as vi.Mock).mockResolvedValue({
        id: mockDefinitionId,
      })

      ;(skillPackageRepo.findByDefinitionAndVersion as vi.Mock).mockResolvedValue(null)

      await expect(
        skillRetryRollbackService.rollbackToVersion(mockUserId, mockDefinitionId, '1.0.0')
      ).rejects.toThrow('目标版本不存在')
    })

    it('应该拒绝非 active 状态的版本', async () => {
      ;(skillDefinitionRepo.findById as vi.Mock).mockResolvedValue({
        id: mockDefinitionId,
      })

      ;(skillPackageRepo.findByDefinitionAndVersion as vi.Mock).mockResolvedValue({
        id: 'pkg-123',
        version: '1.0.0',
        status: 'failed',
      })

      await expect(
        skillRetryRollbackService.rollbackToVersion(mockUserId, mockDefinitionId, '1.0.0')
      ).rejects.toThrow('状态无效')
    })

    it('应该标记当前版本为 deprecated', async () => {
      const targetVersion = '1.0.0'
      const currentVersion = '2.0.0'

      ;(skillDefinitionRepo.findById as vi.Mock).mockResolvedValue({
        id: mockDefinitionId,
        currentVersion,
      })

      ;(skillPackageRepo.findByDefinitionAndVersion as vi.Mock)
        .mockResolvedValueOnce({
          id: 'target-pkg',
          version: targetVersion,
          status: 'active',
        })
        .mockResolvedValueOnce({
          id: 'current-pkg',
          version: currentVersion,
          status: 'active',
        })

      ;(skillInstallLogRepo.create as vi.Mock).mockResolvedValue({
        id: 'log-123',
        startedAt: new Date(),
      })

      ;(skillDefinitionRepo.update as vi.Mock).mockResolvedValue({})
      ;(skillPackageRepo.update as vi.Mock).mockResolvedValue({})
      ;(skillInstallLogRepo.update as vi.Mock).mockResolvedValue({})

      await skillRetryRollbackService.rollbackToVersion(
        mockUserId,
        mockDefinitionId,
        targetVersion
      )

      expect(skillPackageRepo.update).toHaveBeenCalledWith(
        'current-pkg',
        expect.objectContaining({
          status: 'deprecated',
        })
      )
    })

    it('应该��录回滚日志', async () => {
      ;(skillDefinitionRepo.findById as vi.Mock).mockResolvedValue({
        id: mockDefinitionId,
        currentVersion: '2.0.0',
      })

      ;(skillPackageRepo.findByDefinitionAndVersion as vi.Mock).mockResolvedValue({
        id: 'target-pkg',
        version: '1.0.0',
        status: 'active',
      })

      ;(skillInstallLogRepo.create as vi.Mock).mockResolvedValue({
        id: 'log-123',
        startedAt: new Date(),
      })

      ;(skillDefinitionRepo.update as vi.Mock).mockResolvedValue({})
      ;(skillInstallLogRepo.update as vi.Mock).mockResolvedValue({})

      await skillRetryRollbackService.rollbackToVersion(
        mockUserId,
        mockDefinitionId,
        '1.0.0',
        'Test reason'
      )

      expect(skillInstallLogRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          operation: 'rollback',
          message: expect.stringContaining('Test reason'),
        })
      )

      expect(skillInstallLogRepo.update).toHaveBeenCalledWith(
        'log-123',
        expect.objectContaining({
          status: 'success',
        })
      )
    })
  })

  describe('rollbackToPreviousVersion', () => {
    it('应该回滚到上一个版本', async () => {
      const currentVersion = '2.0.0'
      const previousVersion = '1.0.0'

      ;(skillDefinitionRepo.findById as vi.Mock).mockResolvedValue({
        id: mockDefinitionId,
        currentVersion,
      })

      ;(skillPackageRepo.findActiveByDefinition as vi.Mock).mockResolvedValue([
        { version: currentVersion, createdAt: '2024-02-02' },
        { version: previousVersion, createdAt: '2024-01-01' },
      ])

      ;(skillPackageRepo.findByDefinitionAndVersion as vi.Mock).mockResolvedValue({
        id: 'prev-pkg',
        version: previousVersion,
        status: 'active',
      })

      ;(skillInstallLogRepo.create as vi.Mock).mockResolvedValue({
        id: 'log-123',
        startedAt: new Date(),
      })

      ;(skillDefinitionRepo.update as vi.Mock).mockResolvedValue({})
      ;(skillInstallLogRepo.update as vi.Mock).mockResolvedValue({})

      const result = await skillRetryRollbackService.rollbackToPreviousVersion(
        mockUserId,
        mockDefinitionId
      )

      expect(result).toBe('prev-pkg')
    })

    it('应该拒绝没有当前版本的情况', async () => {
      ;(skillDefinitionRepo.findById as vi.Mock).mockResolvedValue({
        id: mockDefinitionId,
        currentVersion: null,
      })

      await expect(
        skillRetryRollbackService.rollbackToPreviousVersion(mockUserId, mockDefinitionId)
      ).rejects.toThrow('当前没有激活的版本')
    })

    it('应该拒绝没有历史版本的情况', async () => {
      ;(skillDefinitionRepo.findById as vi.Mock).mockResolvedValue({
        id: mockDefinitionId,
        currentVersion: '1.0.0',
      })

      ;(skillPackageRepo.findActiveByDefinition as vi.Mock).mockResolvedValue([
        { version: '1.0.0' },
      ])

      await expect(
        skillRetryRollbackService.rollbackToPreviousVersion(mockUserId, mockDefinitionId)
      ).rejects.toThrow('没有可回滚的历史版本')
    })
  })

  describe('getVersionHistory', () => {
    it('应该返回版本历史', async () => {
      ;(skillDefinitionRepo.findById as vi.Mock).mockResolvedValue({
        id: mockDefinitionId,
        currentVersion: '2.0.0',
      })

      ;(skillPackageRepo.findAllByDefinition as vi.Mock).mockResolvedValue([
        {
          id: 'pkg-2',
          version: '2.0.0',
          status: 'active',
          installedAt: '2024-02-02',
        },
        {
          id: 'pkg-1',
          version: '1.0.0',
          status: 'active',
          installedAt: '2024-01-01',
        },
      ])

      const result = await skillRetryRollbackService.getVersionHistory(mockDefinitionId)

      expect(result).toHaveLength(2)
      expect(result[0].version).toBe('2.0.0')
      expect(result[0].isCurrent).toBe(true)
      expect(result[1].version).toBe('1.0.0')
      expect(result[1].isCurrent).toBe(false)
    })
  })

  describe('canRollbackToVersion', () => {
    it('应该允许回滚到 active 版本', async () => {
      ;(skillPackageRepo.findByDefinitionAndVersion as vi.Mock).mockResolvedValue({
        id: 'pkg-123',
        version: '1.0.0',
        status: 'active',
        packagePath: '/path/to/package',
      })

      // Mock fs.pathExists
      const fs = require('fs-extra')
      fs.pathExists = vi.fn().mockResolvedValue(true)

      const result = await skillRetryRollbackService.canRollbackToVersion(
        mockDefinitionId,
        '1.0.0'
      )

      expect(result.canRollback).toBe(true)
    })

    it('应该拒绝不存在的版本', async () => {
      ;(skillPackageRepo.findByDefinitionAndVersion as vi.Mock).mockResolvedValue(null)

      const result = await skillRetryRollbackService.canRollbackToVersion(
        mockDefinitionId,
        '1.0.0'
      )

      expect(result.canRollback).toBe(false)
      expect(result.reason).toContain('不存在')
    })

    it('应该拒绝非 active 状态的版本', async () => {
      ;(skillPackageRepo.findByDefinitionAndVersion as vi.Mock).mockResolvedValue({
        id: 'pkg-123',
        version: '1.0.0',
        status: 'failed',
      })

      const result = await skillRetryRollbackService.canRollbackToVersion(
        mockDefinitionId,
        '1.0.0'
      )

      expect(result.canRollback).toBe(false)
      expect(result.reason).toContain('状态')
    })

    it('应该拒绝包文件不存在的版本', async () => {
      ;(skillPackageRepo.findByDefinitionAndVersion as vi.Mock).mockResolvedValue({
        id: 'pkg-123',
        version: '1.0.0',
        status: 'active',
        packagePath: '/path/to/package',
      })

      const fs = require('fs-extra')
      fs.pathExists = vi.fn().mockResolvedValue(false)

      const result = await skillRetryRollbackService.canRollbackToVersion(
        mockDefinitionId,
        '1.0.0'
      )

      expect(result.canRollback).toBe(false)
      expect(result.reason).toContain('包文件不存在')
    })
  })

  describe('cleanupFailedInstall', () => {
    it('应该清理失败的安装', async () => {
      ;(skillPackageRepo.findByDefinitionAndVersion as vi.Mock).mockResolvedValue({
        id: 'failed-pkg',
        version: '1.0.0',
        status: 'failed',
        packagePath: '/path/to/package',
      })

      const fs = require('fs-extra')
      fs.pathExists = vi.fn().mockResolvedValue(true)
      fs.remove = vi.fn().mockResolvedValue(undefined)

      ;(skillPackageRepo.remove as vi.Mock).mockResolvedValue(true)

      await skillRetryRollbackService.cleanupFailedInstall(mockDefinitionId, '1.0.0')

      expect(fs.remove).toHaveBeenCalledWith('/path/to/package')
      expect(skillPackageRepo.remove).toHaveBeenCalledWith('failed-pkg')
    })

    it('应该忽略不存在的包', async () => {
      ;(skillPackageRepo.findByDefinitionAndVersion as vi.Mock).mockResolvedValue(null)

      await expect(
        skillRetryRollbackService.cleanupFailedInstall(mockDefinitionId, '1.0.0')
      ).resolves.not.toThrow()
    })

    it('应该忽略非 failed 状态的包', async () => {
      ;(skillPackageRepo.findByDefinitionAndVersion as vi.Mock).mockResolvedValue({
        id: 'pkg-123',
        version: '1.0.0',
        status: 'active',
      })

      const fs = require('fs-extra')
      fs.remove = vi.fn()

      await skillRetryRollbackService.cleanupFailedInstall(mockDefinitionId, '1.0.0')

      expect(fs.remove).not.toHaveBeenCalled()
    })
  })
})
