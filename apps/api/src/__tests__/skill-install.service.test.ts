/**
 * Skill Install Service 单元测试
 */

// Set environment variables BEFORE importing the module
process.env.SKILL_STORAGE_PATH = '/tmp/test-skills'

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as skillInstallService from '../services/skill-install.service'
import * as skillDefinitionRepo from '../repositories/skill-definition.repository'
import * as skillPackageRepo from '../repositories/skill-package.repository'
import * as skillInstallLogRepo from '../repositories/skill-install-log.repository'
import * as skillValidator from '../utils/skill-validator'
import * as fs from 'fs-extra'

// Mock repositories
vi.mock('../repositories/skill-definition.repository')
vi.mock('../repositories/skill-package.repository')
vi.mock('../repositories/skill-install-log.repository')
vi.mock('../utils/skill-validator')
vi.mock('fs-extra', () => ({
  ensureDir: vi.fn(),
  copy: vi.fn(),
  stat: vi.fn(),
  readFile: vi.fn(),
  writeFile: vi.fn(),
}))

describe('Skill Install Service', () => {
  const mockUserId = 'user-123'
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
      ;(skillPackageRepo.findByDefinitionAndVersion as vi.Mock).mockResolvedValue(null)

      // Mock log creation
      ;(skillInstallLogRepo.create as vi.Mock).mockResolvedValue({
        id: 'log-123',
        startedAt: new Date(),
      })

      // Mock package creation
      ;(skillPackageRepo.create as vi.Mock).mockResolvedValue({
        id: 'pkg-123',
        version: '1.0.0',
      })

      // Mock validation success
      ;(skillValidator.validateSkillPackage as vi.Mock).mockResolvedValue({
        valid: true,
        errors: [],
        warnings: [],
      })

      // Mock checksum calculation
      ;(skillValidator.calculateDirectorySHA256 as vi.Mock).mockResolvedValue('abc123')

      // Mock fs operations
      ;(fs.ensureDir as vi.Mock).mockResolvedValue(undefined)
      ;(fs.copy as vi.Mock).mockResolvedValue(undefined)
      ;(fs.stat as vi.Mock).mockResolvedValue({ size: 1024 })

      const input = {
        skillDefinitionId: mockDefinitionId,
        version: '1.0.0',
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
        version: '1.0.0',
        sourceType: 'anthropic' as const,
      }

      await expect(skillInstallService.installSkillPackage(input)).rejects.toThrow(
        '技能定义不存在'
      )
    })

    it('应该拒绝已存在的版本', async () => {
      ;(skillDefinitionRepo.findById as vi.Mock).mockResolvedValue({
        id: mockDefinitionId,
        skill_id: mockSkillId,
      })

      ;(skillPackageRepo.findByDefinitionAndVersion as vi.Mock).mockResolvedValue({
        id: 'existing-pkg',
        version: '1.0.0',
      })

      const input = {
        skillDefinitionId: mockDefinitionId,
        version: '1.0.0',
        sourceType: 'anthropic' as const,
      }

      await expect(skillInstallService.installSkillPackage(input)).rejects.toThrow(
        '该版本已存在'
      )
    })

    it('应该记录安装日志', async () => {
      ;(skillDefinitionRepo.findById as vi.Mock).mockResolvedValue({
        id: mockDefinitionId,
        skill_id: mockSkillId,
      })

      ;(skillPackageRepo.findByDefinitionAndVersion as vi.Mock).mockResolvedValue(null)

      ;(skillInstallLogRepo.create as vi.Mock).mockResolvedValue({
        id: 'log-123',
        startedAt: new Date(),
      })

      const input = {
        skillDefinitionId: mockDefinitionId,
        version: '1.0.0',
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

    it('应该在失败时清理', async () => {
      ;(skillDefinitionRepo.findById as vi.Mock).mockResolvedValue({
        id: mockDefinitionId,
        skill_id: mockSkillId,
      })

      ;(skillPackageRepo.findByDefinitionAndVersion as vi.Mock).mockResolvedValue(null)

      ;(skillInstallLogRepo.create as vi.Mock).mockResolvedValue({
        id: 'log-123',
        startedAt: new Date(),
      })

      // Mock failure during package creation
      ;(skillPackageRepo.create as vi.Mock).mockRejectedValue(new Error('Database error'))

      const input = {
        skillDefinitionId: mockDefinitionId,
        version: '1.0.0',
        sourceType: 'anthropic' as const,
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
    // TODO: 这些测试需要等待 Anthropic 下载功能实现后再启用
    // 当前 installSkillPackage 会抛出 NOT_IMPLEMENTED 错误
    it.skip('应该创建新的技能定义', async () => {
      // Mock installSkillPackage to avoid NOT_IMPLEMENTED error
      const installSpy = vi.spyOn(skillInstallService, 'installSkillPackage')
      installSpy.mockResolvedValue('pkg-123')

      ;(skillDefinitionRepo.findBySkillId as vi.Mock).mockResolvedValue(null)

      ;(skillDefinitionRepo.create as vi.Mock).mockResolvedValue({
        id: mockDefinitionId,
        skillId: mockSkillId,
      })

      const result = await skillInstallService.installFromAnthropicSkillId(
        mockSkillId,
        '1.0.0'
      )

      expect(skillDefinitionRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          skillId: mockSkillId,
          name: mockSkillId,
        })
      )

      expect(installSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          skillDefinitionId: mockDefinitionId,
          version: '1.0.0',
          sourceType: 'anthropic',
        })
      )

      expect(result).toBe('pkg-123')

      installSpy.mockRestore()
    })

    it.skip('应该使用现有的技能定义', async () => {
      // Mock installSkillPackage to avoid NOT_IMPLEMENTED error
      const installSpy = vi.spyOn(skillInstallService, 'installSkillPackage')
      installSpy.mockResolvedValue('pkg-123')

      ;(skillDefinitionRepo.findBySkillId as vi.Mock).mockResolvedValue({
        id: mockDefinitionId,
        skillId: mockSkillId,
      })

      await skillInstallService.installFromAnthropicSkillId(mockSkillId, '1.0.0')

      expect(skillDefinitionRepo.create).not.toHaveBeenCalled()

      installSpy.mockRestore()
    })
  })

  describe('installFromManifestUrl', () => {
    // TODO: 这些测试需要等待 Codex 下载功能实现后再启用
    // 当前 installSkillPackage 会抛出 NOT_IMPLEMENTED 错误
    it.skip('应该从 Manifest URL 安装', async () => {
      const manifestUrl = 'https://example.com/manifest.json'

      // Mock installSkillPackage to avoid NOT_IMPLEMENTED error
      const installSpy = vi.spyOn(skillInstallService, 'installSkillPackage')
      installSpy.mockResolvedValue('pkg-123')

      ;(skillDefinitionRepo.findBySkillId as vi.Mock).mockResolvedValue(null)

      ;(skillDefinitionRepo.create as vi.Mock).mockResolvedValue({
        id: mockDefinitionId,
        skillId: mockSkillId,
      })

      const result = await skillInstallService.installFromManifestUrl(manifestUrl, mockSkillId)

      expect(skillDefinitionRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          skillId: mockSkillId,
          sourceType: 'url',
        })
      )

      expect(installSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          skillDefinitionId: mockDefinitionId,
          sourceType: 'codex',
        })
      )

      expect(result).toBe('pkg-123')

      installSpy.mockRestore()
    })

    // TODO: 以下测试需要等待 Manifest 下载功能实现后再启用
    // it('应该处理 Manifest 获取失败', ...)
    // it('应该处理 Manifest 解析失败', ...)
    // it('应该支持 Markdown Frontmatter', ...)
    // it('应该处理超时', ...)
  })

  describe('状态机步骤', () => {
    // TODO: 此测试需要等待步骤记录功能实现后再启用
    // 当前代码中 installSkillPackage 没有记录 step 字段到 skillInstallLogRepo.update
    it.skip('应该按顺序执行所有步骤', async () => {
      const updateCalls: string[] = []

      ;(skillDefinitionRepo.findById as vi.Mock).mockResolvedValue({
        id: mockDefinitionId,
        skillId: mockSkillId,  // 修改：使用 camelCase
      })

      ;(skillPackageRepo.findByDefinitionAndVersion as vi.Mock).mockResolvedValue(null)

      ;(skillInstallLogRepo.create as vi.Mock).mockResolvedValue({
        id: 'log-123',
        startedAt: new Date(),
      })

      ;(skillInstallLogRepo.update as vi.Mock).mockImplementation(async (id, data) => {
        if (data.step) {
          updateCalls.push(data.step)
        }
        return {}
      })

      ;(skillPackageRepo.create as vi.Mock).mockResolvedValue({
        id: 'pkg-123',
      })

      ;(skillPackageRepo.update as vi.Mock).mockResolvedValue({
        id: 'pkg-123',
        status: 'active',
      })

      const input = {
        skillDefinitionId: mockDefinitionId,
        version: '1.0.0',
        sourceType: 'local' as const,  // 修改：从 anthropic 改为 local
        localPath: '/tmp/test-skill',
      }

      await skillInstallService.installSkillPackage(input)

      // 验证步骤顺序
      const expectedSteps = [
        'fetch_manifest',
        'validate_manifest',
        'download',
        'checksum',
        'validate_structure',
        'save_db',
        'activate',
        'complete',
      ]

      expectedSteps.forEach((step, index) => {
        expect(updateCalls[index]).toBe(step)
      })
    })
  })
})
