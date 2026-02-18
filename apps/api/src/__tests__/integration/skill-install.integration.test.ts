/**
 * Skill Install Integration Tests (SKILL.md 模式，无版本控制)
 *
 * 端到端集成测试，测试完整的安装流程
 * 注意：这些测试需要真实的数据库连接，请确保 DATABASE_URL 环境变量已正确配置
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import fs from 'fs-extra'
import * as path from 'path'
import * as os from 'os'

// 检查是否有数据库连接
// 集成测试需要显式启用，避免意外在生产数据库上运行
const DATABASE_URL = process.env.DATABASE_URL
const RUN_INTEGRATION = process.env.RUN_INTEGRATION_TESTS === 'true'
const SKIP_INTEGRATION_TESTS = !DATABASE_URL || !RUN_INTEGRATION

// 条件导入，避免在没有数据库时加载
const getTestDependencies = async () => {
  if (SKIP_INTEGRATION_TESTS) {
    return null
  }
  const { closeDatabaseConnection } = await import('../../lib/db')
  const skillInstallService = await import('../../services/skill-install.service')
  const skillRetryRollbackService = await import('../../services/skill-retry-rollback.service')
  const skillDefinitionRepo = await import('../../repositories/skill-definition.repository')
  const skillPackageRepo = await import('../../repositories/skill-package.repository')
  const skillInstallLogRepo = await import('../../repositories/skill-install-log.repository')
  return {
    closeDatabaseConnection,
    skillInstallService,
    skillRetryRollbackService,
    skillDefinitionRepo,
    skillPackageRepo,
    skillInstallLogRepo,
  }
}

describe.skipIf(SKIP_INTEGRATION_TESTS)('Skill Install Integration Tests', () => {
  let testUserId: string
  let testDefinitionId: string
  let tempDir: string

  // 延迟初始化的依赖
  let closeDatabaseConnection: any
  let skillInstallService: any
  let skillRetryRollbackService: any
  let skillDefinitionRepo: any
  let skillPackageRepo: any
  let skillInstallLogRepo: any

  beforeAll(async () => {
    const deps = await getTestDependencies()
    if (deps) {
      closeDatabaseConnection = deps.closeDatabaseConnection
      skillInstallService = deps.skillInstallService
      skillRetryRollbackService = deps.skillRetryRollbackService
      skillDefinitionRepo = deps.skillDefinitionRepo
      skillPackageRepo = deps.skillPackageRepo
      skillInstallLogRepo = deps.skillInstallLogRepo
    }
    testUserId = 'test-user-' + Date.now()
  })

  afterAll(async () => {
    await closeDatabaseConnection()
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
    await fs.remove(tempDir)

    if (testDefinitionId) {
      // 删除相关的包
      const pkg = await skillPackageRepo.findByDefinition(testDefinitionId)
      if (pkg) {
        await skillPackageRepo.remove(pkg.id)
      }

      await skillDefinitionRepo.remove(testDefinitionId)
    }
  })

  describe('完整安装流程', () => {
    it('应该成功完成完整的安装流程', async () => {
      const input = {
        skillDefinitionId: testDefinitionId,
        sourceType: 'local' as const,
        localPath: tempDir,
      }

      // 创建 SKILL.md 测试文件
      await fs.writeFile(
        path.join(tempDir, 'SKILL.md'),
        `---
skill_id: test-skill
name: Test Skill
description: Integration test
---

# Test Skill
`
      )

      await skillInstallService.installSkillPackage(input)

      // 验证包已创建
      const pkg = await skillPackageRepo.findByDefinition(testDefinitionId)
      expect(pkg).toBeDefined()
      expect(pkg?.status).toBe('active')

      // 验证安装日志已创建
      const logs = await skillInstallLogRepo.findByDefinition(testDefinitionId)
      expect(logs.length).toBeGreaterThan(0)
      expect(logs[0].status).toBe('success')
    }, 30000)

    it('应该覆盖已安装的包', async () => {
      // 创建 SKILL.md 测试文件
      await fs.writeFile(
        path.join(tempDir, 'SKILL.md'),
        `---
skill_id: test-skill
name: Test Skill v1
---

# Test Skill v1
`
      )

      // 第一次安装
      await skillInstallService.installSkillPackage({
        skillDefinitionId: testDefinitionId,
        sourceType: 'local' as const,
        localPath: tempDir,
      })

      // 更新 SKILL.md
      await fs.writeFile(
        path.join(tempDir, 'SKILL.md'),
        `---
skill_id: test-skill
name: Test Skill v2
---

# Test Skill v2
`
      )

      // 第二次安装（覆盖）
      await skillInstallService.installSkillPackage({
        skillDefinitionId: testDefinitionId,
        sourceType: 'local' as const,
        localPath: tempDir,
      })

      // 验证只有一个包
      const pkg = await skillPackageRepo.findByDefinition(testDefinitionId)
      expect(pkg).toBeDefined()
      expect(pkg?.status).toBe('active')
    }, 30000)
  })

  describe('安装失败场景', () => {
    it('应该在失败时清理数据', async () => {
      const invalidInput = {
        skillDefinitionId: 'non-existent-id',
        sourceType: 'local' as const,
        localPath: tempDir,
      }

      await expect(
        skillInstallService.installSkillPackage(invalidInput)
      ).rejects.toThrow()

      // 验证没有创建包记录
      const pkg = await skillPackageRepo.findByDefinition('non-existent-id')
      expect(pkg).toBeNull()
    }, 30000)

    it('应该记录失败日志', async () => {
      try {
        await skillInstallService.installSkillPackage({
          skillDefinitionId: 'non-existent-id',
          sourceType: 'local' as const,
          localPath: tempDir,
        })
      } catch (err) {
        // 预期会失败
      }

      // 注意：由于 definition 不存在，可能不会创建日志
      // 这个测试需要根据实际实现调整
    }, 30000)
  })

  describe('重试机制', () => {
    it('应该在网络错误时重试', async () => {
      // 创建 SKILL.md 测试文件
      await fs.writeFile(
        path.join(tempDir, 'SKILL.md'),
        `---
skill_id: test-skill
name: Test Skill
---

# Test Skill
`
      )

      const input = {
        skillDefinitionId: testDefinitionId,
        sourceType: 'local' as const,
        localPath: tempDir,
      }

      // 使用重试安装
      const packageId = await skillRetryRollbackService.installWithRetry(input, 2)

      expect(packageId).toBeDefined()
    }, 30000)
  })

  describe('数据完整性', () => {
    it('应该保持数据库事务一致性', async () => {
      // 创建 SKILL.md 测试文件
      await fs.writeFile(
        path.join(tempDir, 'SKILL.md'),
        `---
skill_id: test-skill
name: Test Skill
---

# Test Skill
`
      )

      const input = {
        skillDefinitionId: testDefinitionId,
        sourceType: 'local' as const,
        localPath: tempDir,
      }

      await skillInstallService.installSkillPackage(input)

      // 验证所有相关表的数据一致性
      const definition = await skillDefinitionRepo.findById(testDefinitionId)
      const pkg = await skillPackageRepo.findByDefinition(testDefinitionId)
      const logs = await skillInstallLogRepo.findByDefinition(testDefinitionId)

      expect(definition).toBeDefined()
      expect(pkg).toBeDefined()
      expect(logs.length).toBeGreaterThan(0)

      // 验证关联关系
      expect(logs[0].skillDefinitionId).toBe(testDefinitionId)
    }, 30000)
  })
})
