/**
 * Skill Install Service 单元测试 (SKILL.md 模式，无版本控制)
 */

// Set environment variables BEFORE importing the module
process.env.SKILL_STORAGE_PATH = '/tmp/test-skills'

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as skillInstallService from '../services/skill-install.service'
import * as skillDefinitionRepo from '../repositories/skill-definition.repository'
import * as skillPackageRepo from '../repositories/skill-package.repository'
import * as skillInstallLogRepo from '../repositories/skill-install-log.repository'
import * as skillValidator from '../utils/skill-validator'
import fs from 'fs-extra'

// Mock repositories
vi.mock('../repositories/skill-definition.repository')
vi.mock('../repositories/skill-package.repository')
vi.mock('../repositories/skill-install-log.repository')
vi.mock('../utils/skill-validator')
vi.mock('fs-extra', () => {
  const fns = {
    ensureDir: vi.fn(),
    copy: vi.fn(),
    stat: vi.fn(),
    readFile: vi.fn(),
    writeFile: vi.fn(),
    pathExists: vi.fn(),
    remove: vi.fn(),
  }
  return { default: fns, ...fns }
})

describe('Skill Install Service', () => {
  const mockDefinitionId = 'def-123'
  const mockSkillId = 'test-skill'

  beforeEach(() => {
    vi.clearAllMocks()
    // Set required environment variables for tests
    process.env.SKILL_STORAGE_PATH = '/tmp/test-skills'
  })

  afterEach(() => {
    // Clean up environment variables
    delete process.env.SKILL_STORAGE_PATH
  })

  describe('installSkillPackage', () => {
    it('应该成功安装技能包', async () => {
      // Mock definition exists
      ;(skillDefinitionRepo.findById as vi.Mock).mockResolvedValue({
        id: mockDefinitionId,
        skillId: mockSkillId,
        name: 'Test Skill',
      })

      // Mock no existing package
      ;(skillPackageRepo.findByDefinition as vi.Mock).mockResolvedValue(null)

      // Mock log creation
      ;(skillInstallLogRepo.create as vi.Mock).mockResolvedValue({
        id: 'log-123',
        startedAt: new Date(),
      })

      // Mock package creation
      ;(skillPackageRepo.create as vi.Mock).mockResolvedValue({
        id: 'pkg-123',
      })

      // Mock validation success
      ;(skillValidator.validateSkillPackage as vi.Mock).mockResolvedValue({
        valid: true,
        errors: [],
        warnings: [],
        skillMd: { skill_id: mockSkillId, name: 'Test Skill' },
      })

      // Mock checksum calculation
      ;(skillValidator.calculateDirectorySHA256 as vi.Mock).mockResolvedValue('abc123')

      // Mock fs operations
      ;(fs.ensureDir as vi.Mock).mockResolvedValue(undefined)
      ;(fs.copy as vi.Mock).mockResolvedValue(undefined)
      ;(fs.stat as vi.Mock).mockResolvedValue({ size: 1024 })
      ;(fs.pathExists as vi.Mock).mockResolvedValue(false)

      // Mock package update
      ;(skillPackageRepo.update as vi.Mock).mockResolvedValue({})
      ;(skillInstallLogRepo.update as vi.Mock).mockResolvedValue({})

      const input = {
        skillDefinitionId: mockDefinitionId,
        sourceType: 'local' as const,
        localPath: '/tmp/test-skill',
      }

      const result = await skillInstallService.installSkillPackage(input)

      expect(result).toBe('pkg-123')
      expect(skillDefinitionRepo.findById).toHaveBeenCalledWith(mockDefinitionId)
      expect(skillPackageRepo.create).toHaveBeenCalled()
    })

    it('应该拒绝不存在的技能定义', async () => {
      ;(skillDefinitionRepo.findById as vi.Mock).mockResolvedValue(null)

      const input = {
        skillDefinitionId: mockDefinitionId,
        sourceType: 'anthropic' as const,
      }

      await expect(skillInstallService.installSkillPackage(input)).rejects.toThrow(
        '技能定义不存在'
      )
    })

    it('应该覆盖已存在的包', async () => {
      // Mock definition exists
      ;(skillDefinitionRepo.findById as vi.Mock).mockResolvedValue({
        id: mockDefinitionId,
        skillId: mockSkillId,
      })

      // Mock existing package (should be cleaned up)
      ;(skillPackageRepo.findByDefinition as vi.Mock).mockResolvedValue({
        id: 'old-pkg',
        packagePath: '/tmp/old-path',
      })

      // Mock fs.pathExists for cleanup
      ;(fs.pathExists as vi.Mock).mockResolvedValue(true)
      ;(fs.remove as vi.Mock).mockResolvedValue(undefined)

      // Mock log creation
      ;(skillInstallLogRepo.create as vi.Mock).mockResolvedValue({
        id: 'log-123',
        startedAt: new Date(),
      })

      // Mock package creation (upsert)
      ;(skillPackageRepo.create as vi.Mock).mockResolvedValue({
        id: 'pkg-new',
      })

      // Mock validation success
      ;(skillValidator.validateSkillPackage as vi.Mock).mockResolvedValue({
        valid: true,
        errors: [],
        warnings: [],
        skillMd: { skill_id: mockSkillId, name: 'Test Skill' },
      })

      ;(skillValidator.calculateDirectorySHA256 as vi.Mock).mockResolvedValue('abc123')
      ;(fs.ensureDir as vi.Mock).mockResolvedValue(undefined)
      ;(fs.copy as vi.Mock).mockResolvedValue(undefined)
      ;(fs.stat as vi.Mock).mockResolvedValue({ size: 1024 })
      ;(skillPackageRepo.update as vi.Mock).mockResolvedValue({})
      ;(skillInstallLogRepo.update as vi.Mock).mockResolvedValue({})

      const input = {
        skillDefinitionId: mockDefinitionId,
        sourceType: 'local' as const,
        localPath: '/tmp/test-skill',
      }

      const result = await skillInstallService.installSkillPackage(input)

      expect(result).toBe('pkg-new')
      // Should have cleaned up old package path
      expect(fs.remove).toHaveBeenCalledWith('/tmp/old-path')
    })

    it('应该记录安装日志', async () => {
      ;(skillDefinitionRepo.findById as vi.Mock).mockResolvedValue({
        id: mockDefinitionId,
        skillId: mockSkillId,
      })

      ;(skillPackageRepo.findByDefinition as vi.Mock).mockResolvedValue(null)

      ;(skillInstallLogRepo.create as vi.Mock).mockResolvedValue({
        id: 'log-123',
        startedAt: new Date(),
      })

      const input = {
        skillDefinitionId: mockDefinitionId,
        sourceType: 'anthropic' as const,
      }

      try {
        await skillInstallService.installSkillPackage(input)
      } catch (err) {
        // 可能因为其他 mock 失败
      }

      expect(skillInstallLogRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          skillDefinitionId: mockDefinitionId,
          operation: 'install',
          status: 'pending',
        })
      )
    })

    it('应该在失败时更新日志状态', async () => {
      ;(skillDefinitionRepo.findById as vi.Mock).mockResolvedValue({
        id: mockDefinitionId,
        skillId: mockSkillId,
      })

      ;(skillPackageRepo.findByDefinition as vi.Mock).mockResolvedValue(null)

      ;(skillInstallLogRepo.create as vi.Mock).mockResolvedValue({
        id: 'log-123',
        startedAt: new Date(),
      })

      // Mock failure during package creation
      ;(skillPackageRepo.create as vi.Mock).mockRejectedValue(new Error('Database error'))
      ;(skillInstallLogRepo.update as vi.Mock).mockResolvedValue({})

      const input = {
        skillDefinitionId: mockDefinitionId,
        sourceType: 'local' as const,
        localPath: '/tmp/test-skill',
      }

      await expect(skillInstallService.installSkillPackage(input)).rejects.toThrow()

      // Should update log with failure
      expect(skillInstallLogRepo.update).toHaveBeenCalledWith(
        'log-123',
        expect.objectContaining({
          status: 'failed',
        })
      )
    })
  })

  describe('installFromAnthropicSkillId', () => {
    it.skip('应该创建新的技能定义', async () => {
      // Mock installSkillPackage to avoid NOT_IMPLEMENTED error
      const installSpy = vi.spyOn(skillInstallService, 'installSkillPackage')
      installSpy.mockResolvedValue('pkg-123')

      ;(skillDefinitionRepo.findBySkillId as vi.Mock).mockResolvedValue(null)

      ;(skillDefinitionRepo.create as vi.Mock).mockResolvedValue({
        id: mockDefinitionId,
        skillId: mockSkillId,
      })

      const result = await skillInstallService.installFromAnthropicSkillId(mockSkillId)

      expect(skillDefinitionRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          skillId: mockSkillId,
          name: mockSkillId,
        })
      )

      expect(installSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          skillDefinitionId: mockDefinitionId,
          sourceType: 'anthropic',
        })
      )

      expect(result).toBe('pkg-123')

      installSpy.mockRestore()
    })

    it.skip('应该使用现有的技能定义', async () => {
      const installSpy = vi.spyOn(skillInstallService, 'installSkillPackage')
      installSpy.mockResolvedValue('pkg-123')

      ;(skillDefinitionRepo.findBySkillId as vi.Mock).mockResolvedValue({
        id: mockDefinitionId,
        skillId: mockSkillId,
      })

      await skillInstallService.installFromAnthropicSkillId(mockSkillId)

      expect(skillDefinitionRepo.create).not.toHaveBeenCalled()

      installSpy.mockRestore()
    })
  })
})
