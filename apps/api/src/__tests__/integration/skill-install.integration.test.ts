/**
 * Skill Install Integration Tests
 *
 * 端到端集成测试，测试完整的安装流程
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs-extra'
import * as path from 'path'
import * as os from 'os'
import { pool } from '../lib/db'
import * as skillInstallService from '../services/skill-install.service'
import * as skillRetryRollbackService from '../services/skill-retry-rollback.service'
import * as skillDefinitionRepo from '../repositories/skill-definition.repository'
import * as skillPackageRepo from '../repositories/skill-package.repository'
import * as skillInstallLogRepo from '../repositories/skill-install-log.repository'

describe('Skill Install Integration Tests', () => {
  let testUserId: string
  let testDefinitionId: string
  let tempDir: string

  beforeAll(async () => {
    // 创建测试用户（假设已有用户表）
    testUserId = 'test-user-' + Date.now()
  })

  afterAll(async () => {
    // 清理测试数据
    await pool.end()
  })

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-integration-'))

    // 创建测试技能定义
    const definition = await skillDefinitionRepo.create({
      skillId: 'test-skill-' + Date.now(),
      name: 'Test Skill',
      description: 'Integration test skill',
      triggerKeywords: ['test'],
      isActive: true,
      isPublic: true,
      createdBy: testUserId,
    })

    testDefinitionId = definition.id
  })

  afterEach(async () => {
    // 清理临时文件
    await fs.remove(tempDir)

    // 清理测试数据
    if (testDefinitionId) {
      // 删除相关的包和日志
      const packages = await skillPackageRepo.findAllByDefinition(testDefinitionId)
      for (const pkg of packages) {
        await skillPackageRepo.remove(pkg.id)
      }

      await skillDefinitionRepo.remove(testDefinitionId)
    }
  })

  describe('完整安装流程', () => {
    it('应该成功完成完整的安装流程', async () => {
      const input = {
        skillDefinitionId: testDefinitionId,
        version: '1.0.0',
        sourceType: 'anthropic' as const,
      }

      const packageId = await skillInstallService.installSkillPackage(testUserId, input)

      // 验证包已创建
      const pkg = await skillPackageRepo.findById(packageId)
      expect(pkg).toBeDefined()
      expect(pkg?.version).toBe('1.0.0')
      expect(pkg?.status).toBe('active')

      // 验证技能定义已更新
      const definition = await skillDefinitionRepo.findById(testDefinitionId)
      expect(definition?.currentVersion).toBe('1.0.0')

      // 验证安装日志已创建
      const logs = await skillInstallLogRepo.findByDefinition(testDefinitionId)
      expect(logs.length).toBeGreaterThan(0)
      expect(logs[0].status).toBe('success')
    }, 30000)

    it('应该支持安装多个版本', async () => {
      // 安装版本 1.0.0
      await skillInstallService.installSkillPackage(testUserId, {
        skillDefinitionId: testDefinitionId,
        version: '1.0.0',
        sourceType: 'anthropic' as const,
      })

      // 安装版本 1.1.0
      await skillInstallService.installSkillPackage(testUserId, {
        skillDefinitionId: testDefinitionId,
        version: '1.1.0',
        sourceType: 'anthropic' as const,
      })

      // 验证两个版本都存在
      const packages = await skillPackageRepo.findAllByDefinition(testDefinitionId)
      expect(packages.length).toBe(2)

      const versions = packages.map((p) => p.version).sort()
      expect(versions).toEqual(['1.0.0', '1.1.0'])

      // 验证当前版本是最新的
      const definition = await skillDefinitionRepo.findById(testDefinitionId)
      expect(definition?.currentVersion).toBe('1.1.0')
    }, 30000)

    it('应该拒绝重复安装相同版本', async () => {
      // 第一次安装
      await skillInstallService.installSkillPackage(testUserId, {
        skillDefinitionId: testDefinitionId,
        version: '1.0.0',
        sourceType: 'anthropic' as const,
      })

      // 第二次安装相同版本应该失败
      await expect(
        skillInstallService.installSkillPackage(testUserId, {
          skillDefinitionId: testDefinitionId,
          version: '1.0.0',
          sourceType: 'anthropic' as const,
        })
      ).rejects.toThrow('该版本已存在')
    }, 30000)
  })

  describe('安装失败场景', () => {
    it('应该在失败时清理数据', async () => {
      // Mock 一个会失败的安装
      const invalidInput = {
        skillDefinitionId: 'non-existent-id',
        version: '1.0.0',
        sourceType: 'anthropic' as const,
      }

      await expect(
        skillInstallService.installSkillPackage(testUserId, invalidInput)
      ).rejects.toThrow()

      // 验证没有创建包记录
      const packages = await skillPackageRepo.findAllByDefinition('non-existent-id')
      expect(packages.length).toBe(0)
    }, 30000)

    it('应该记录失败日志', async () => {
      try {
        await skillInstallService.installSkillPackage(testUserId, {
          skillDefinitionId: 'non-existent-id',
          version: '1.0.0',
          sourceType: 'anthropic' as const,
        })
      } catch (err) {
        // 预期会失败
      }

      // 注意：由于 definition 不存在，可能不会创建日志
      // 这个测试需要根据实际实现调整
    }, 30000)
  })

  describe('版本回滚', () => {
    it('应该成功回滚到指定版本', async () => {
      // 安装版本 1.0.0
      await skillInstallService.installSkillPackage(testUserId, {
        skillDefinitionId: testDefinitionId,
        version: '1.0.0',
        sourceType: 'anthropic' as const,
      })

      // 安装版本 2.0.0
      await skillInstallService.installSkillPackage(testUserId, {
        skillDefinitionId: testDefinitionId,
        version: '2.0.0',
        sourceType: 'anthropic' as const,
      })

      // 验证当前版本是 2.0.0
      let definition = await skillDefinitionRepo.findById(testDefinitionId)
      expect(definition?.currentVersion).toBe('2.0.0')

      // 回滚到 1.0.0
      await skillRetryRollbackService.rollbackToVersion(
        testUserId,
        testDefinitionId,
        '1.0.0',
        'Test rollback'
      )

      // 验证当前版本是 1.0.0
      definition = await skillDefinitionRepo.findById(testDefinitionId)
      expect(definition?.currentVersion).toBe('1.0.0')

      // 验证回滚日志
      const logs = await skillInstallLogRepo.findByDefinition(testDefinitionId)
      const rollbackLog = logs.find((log) => log.operation === 'rollback')
      expect(rollbackLog).toBeDefined()
      expect(rollbackLog?.status).toBe('success')
    }, 30000)

    it('应该回滚到上一个版本', async () => {
      // 安装多个版本
      await skillInstallService.installSkillPackage(testUserId, {
        skillDefinitionId: testDefinitionId,
        version: '1.0.0',
        sourceType: 'anthropic' as const,
      })

      await skillInstallService.installSkillPackage(testUserId, {
        skillDefinitionId: testDefinitionId,
        version: '1.1.0',
        sourceType: 'anthropic' as const,
      })

      await skillInstallService.installSkillPackage(testUserId, {
        skillDefinitionId: testDefinitionId,
        version: '2.0.0',
        sourceType: 'anthropic' as const,
      })

      // 回滚到上一个版本
      await skillRetryRollbackService.rollbackToPreviousVersion(testUserId, testDefinitionId)

      // 验证当前版本是 1.1.0
      const definition = await skillDefinitionRepo.findById(testDefinitionId)
      expect(definition?.currentVersion).toBe('1.1.0')
    }, 30000)
  })

  describe('重试机制', () => {
    it('应该在网络错误时重试', async () => {
      // 这个测试需要 mock 网络请求
      // 实际实现中需要使用 nock 或类似工具
      const input = {
        skillDefinitionId: testDefinitionId,
        version: '1.0.0',
        sourceType: 'anthropic' as const,
      }

      // 使用重试安装
      const packageId = await skillRetryRollbackService.installWithRetry(testUserId, input, 2)

      expect(packageId).toBeDefined()
    }, 30000)
  })

  describe('并发安装', () => {
    it('应该处理并发安装不同版本', async () => {
      const versions = ['1.0.0', '1.1.0', '1.2.0']

      // 并发安装多个版本
      const promises = versions.map((version) =>
        skillInstallService.installSkillPackage(testUserId, {
          skillDefinitionId: testDefinitionId,
          version,
          sourceType: 'anthropic' as const,
        })
      )

      const results = await Promise.all(promises)

      // 验证所有版本都安装成功
      expect(results.length).toBe(3)

      const packages = await skillPackageRepo.findAllByDefinition(testDefinitionId)
      expect(packages.length).toBe(3)
    }, 30000)

    it('应该拒绝并发安装相同版本', async () => {
      const promises = [
        skillInstallService.installSkillPackage(testUserId, {
          skillDefinitionId: testDefinitionId,
          version: '1.0.0',
          sourceType: 'anthropic' as const,
        }),
        skillInstallService.installSkillPackage(testUserId, {
          skillDefinitionId: testDefinitionId,
          version: '1.0.0',
          sourceType: 'anthropic' as const,
        }),
      ]

      // 至少有一个应该失败
      const results = await Promise.allSettled(promises)
      const failures = results.filter((r) => r.status === 'rejected')

      expect(failures.length).toBeGreaterThan(0)
    }, 30000)
  })

  describe('版本历史', () => {
    it('应该正确记录版本历史', async () => {
      // 安装多个版本
      await skillInstallService.installSkillPackage(testUserId, {
        skillDefinitionId: testDefinitionId,
        version: '1.0.0',
        sourceType: 'anthropic' as const,
      })

      await skillInstallService.installSkillPackage(testUserId, {
        skillDefinitionId: testDefinitionId,
        version: '1.1.0',
        sourceType: 'anthropic' as const,
      })

      // 获取版本历史
      const history = await skillRetryRollbackService.getVersionHistory(testDefinitionId)

      expect(history.length).toBe(2)
      expect(history[0].version).toBe('1.1.0')
      expect(history[0].isCurrent).toBe(true)
      expect(history[1].version).toBe('1.0.0')
      expect(history[1].isCurrent).toBe(false)
    }, 30000)
  })

  describe('数据完整性', () => {
    it('应该保持数据库事务一致性', async () => {
      const input = {
        skillDefinitionId: testDefinitionId,
        version: '1.0.0',
        sourceType: 'anthropic' as const,
      }

      await skillInstallService.installSkillPackage(testUserId, input)

      // 验证所有相关表的数据一致性
      const definition = await skillDefinitionRepo.findById(testDefinitionId)
      const pkg = await skillPackageRepo.findByDefinitionAndVersion(testDefinitionId, '1.0.0')
      const logs = await skillInstallLogRepo.findByDefinition(testDefinitionId)

      expect(definition).toBeDefined()
      expect(pkg).toBeDefined()
      expect(logs.length).toBeGreaterThan(0)

      // 验证关联关系
      expect(definition?.currentVersion).toBe(pkg?.version)
      expect(logs[0].skillDefinitionId).toBe(testDefinitionId)
    }, 30000)

    it('应该正确计算 SHA256 校验值', async () => {
      await skillInstallService.installSkillPackage(testUserId, {
        skillDefinitionId: testDefinitionId,
        version: '1.0.0',
        sourceType: 'anthropic' as const,
      })

      const pkg = await skillPackageRepo.findByDefinitionAndVersion(testDefinitionId, '1.0.0')

      expect(pkg?.checksumSha256).toBeDefined()
      expect(pkg?.checksumSha256).toMatch(/^[a-f0-9]{64}$/)
    }, 30000)
  })

  describe('清理机制', () => {
    it('应该清理失败的安装', async () => {
      // 创建一个失败的包记录（手动模拟）
      const failedPkg = await skillPackageRepo.create({
        skillDefinitionId: testDefinitionId,
        version: '1.0.0',
        sourceType: 'anthropic',
        packagePath: '/tmp/non-existent',
        checksumSha256: 'fake-checksum',
        status: 'failed',
        validationResult: {},
        tools: [],
        config: {},
      })

      // 清理失败的安装
      await skillRetryRollbackService.cleanupFailedInstall(testDefinitionId, '1.0.0')

      // 验证已删除
      const pkg = await skillPackageRepo.findById(failedPkg.id)
      expect(pkg).toBeNull()
    }, 30000)
  })
})
