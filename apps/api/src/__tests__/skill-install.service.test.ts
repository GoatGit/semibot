/**
 * Skill Install Service 单元测试
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as skillInstallService from '../services/skill-install.service'
import * as skillDefinitionRepo from '../repositories/skill-definition.repository'
import * as skillPackageRepo from '../repositories/skill-package.repository'
import * as skillInstallLogRepo from '../repositories/skill-install-log.repository'

// Mock repositories
vi.mock('../repositories/skill-definition.repository')
vi.mock('../repositories/skill-package.repository')
vi.mock('../repositories/skill-install-log.repository')
vi.mock('../utils/skill-validator')
vi.mock('fs-extra')

describe('Skill Install Service', () => {
  const mockUserId = 'user-123'
  const mockDefinitionId = 'def-123'
  const mockSkillId = 'test-skill'

  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('installSkillPackage', () => {
    it('应该成功安装技能包', async () => {
      // Mock definition exists
      ;(skillDefinitionRepo.findById as vi.Mock).mockResolvedValue({
        id: mockDefinitionId,
        skill_id: mockSkillId,
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

      const input = {
        skillDefinitionId: mockDefinitionId,
        version: '1.0.0',
        sourceType: 'anthropic' as const,
      }

      const result = await skillInstallService.installSkillPackage(mockUserId, input)

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

      await expect(skillInstallService.installSkillPackage(mockUserId, input)).rejects.toThrow(
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

      await expect(skillInstallService.installSkillPackage(mockUserId, input)).rejects.toThrow(
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
        await skillInstallService.installSkillPackage(mockUserId, input)
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

      await expect(skillInstallService.installSkillPackage(mockUserId, input)).rejects.toThrow()

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
    it('应该创建新的技能定义', async () => {
      ;(skillDefinitionRepo.findBySkillId as vi.Mock).mockResolvedValue(null)

      ;(skillDefinitionRepo.create as vi.Mock).mockResolvedValue({
        id: mockDefinitionId,
        skill_id: mockSkillId,
      })

      ;(skillPackageRepo.findByDefinitionAndVersion as vi.Mock).mockResolvedValue(null)

      ;(skillInstallLogRepo.create as vi.Mock).mockResolvedValue({
        id: 'log-123',
        startedAt: new Date(),
      })

      ;(skillPackageRepo.create as vi.Mock).mockResolvedValue({
        id: 'pkg-123',
      })

      const result = await skillInstallService.installFromAnthropicSkillId(
        mockUserId,
        mockSkillId,
        '1.0.0'
      )

      expect(skillDefinitionRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          skillId: mockSkillId,
          name: mockSkillId,
        })
      )

      expect(result).toBe('pkg-123')
    })

    it('应该使用现有的技能定义', async () => {
      ;(skillDefinitionRepo.findBySkillId as vi.Mock).mockResolvedValue({
        id: mockDefinitionId,
        skill_id: mockSkillId,
      })

      ;(skillPackageRepo.findByDefinitionAndVersion as vi.Mock).mockResolvedValue(null)

      ;(skillInstallLogRepo.create as vi.Mock).mockResolvedValue({
        id: 'log-123',
        startedAt: new Date(),
      })

      ;(skillPackageRepo.create as vi.Mock).mockResolvedValue({
        id: 'pkg-123',
      })

      await skillInstallService.installFromAnthropicSkillId(mockUserId, mockSkillId, '1.0.0')

      expect(skillDefinitionRepo.create).not.toHaveBeenCalled()
    })
  })

  describe('installFromManifestUrl', () => {
    it('应该从 Manifest URL 安装', async () => {
      const manifestUrl = 'https://example.com/manifest.json'

      // Mock fetch
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        text: async () =>
          JSON.stringify({
            skill_id: mockSkillId,
            name: 'Test Skill',
            version: '1.0.0',
            description: 'Test description',
          }),
        headers: {
          get: () => 'application/json',
        },
      }) as any

      ;(skillDefinitionRepo.findBySkillId as vi.Mock).mockResolvedValue(null)

      ;(skillDefinitionRepo.create as vi.Mock).mockResolvedValue({
        id: mockDefinitionId,
        skill_id: mockSkillId,
      })

      ;(skillPackageRepo.findByDefinitionAndVersion as vi.Mock).mockResolvedValue(null)

      ;(skillInstallLogRepo.create as vi.Mock).mockResolvedValue({
        id: 'log-123',
        startedAt: new Date(),
      })

      ;(skillPackageRepo.create as vi.Mock).mockResolvedValue({
        id: 'pkg-123',
      })

      const result = await skillInstallService.installFromManifestUrl(mockUserId, manifestUrl)

      expect(global.fetch).toHaveBeenCalledWith(
        manifestUrl,
        expect.objectContaining({
          method: 'GET',
        })
      )

      expect(result).toBe('pkg-123')
    })

    it('应该处理 Manifest 获取失败', async () => {
      const manifestUrl = 'https://example.com/manifest.json'

      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
      }) as any

      await expect(
        skillInstallService.installFromManifestUrl(mockUserId, manifestUrl)
      ).rejects.toThrow()
    })

    it('应该处理 Manifest 解析失败', async () => {
      const manifestUrl = 'https://example.com/manifest.json'

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        text: async () => 'invalid json',
        headers: {
          get: () => 'application/json',
        },
      }) as any

      await expect(
        skillInstallService.installFromManifestUrl(mockUserId, manifestUrl)
      ).rejects.toThrow()
    })

    it('应该支持 Markdown Frontmatter', async () => {
      const manifestUrl = 'https://example.com/manifest.md'

      const markdown = `---
skill_id: ${mockSkillId}
version: 1.0.0
name: Test Skill
---

# Test Skill
`

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        text: async () => markdown,
        headers: {
          get: () => 'text/markdown',
        },
      }) as any

      ;(skillDefinitionRepo.findBySkillId as vi.Mock).mockResolvedValue(null)

      ;(skillDefinitionRepo.create as vi.Mock).mockResolvedValue({
        id: mockDefinitionId,
        skill_id: mockSkillId,
      })

      ;(skillPackageRepo.findByDefinitionAndVersion as vi.Mock).mockResolvedValue(null)

      ;(skillInstallLogRepo.create as vi.Mock).mockResolvedValue({
        id: 'log-123',
        startedAt: new Date(),
      })

      ;(skillPackageRepo.create as vi.Mock).mockResolvedValue({
        id: 'pkg-123',
      })

      const result = await skillInstallService.installFromManifestUrl(mockUserId, manifestUrl)

      expect(result).toBe('pkg-123')
    })

    it('应该处理超时', async () => {
      const manifestUrl = 'https://example.com/manifest.json'

      global.fetch = vi.fn().mockImplementation(
        () =>
          new Promise((_, reject) => {
            setTimeout(() => reject(new Error('AbortError')), 100)
          })
      ) as any

      await expect(
        skillInstallService.installFromManifestUrl(mockUserId, manifestUrl)
      ).rejects.toThrow()
    }, 15000)
  })

  describe('状态机步骤', () => {
    it('应该按顺序执行所有步骤', async () => {
      const updateCalls: string[] = []

      ;(skillDefinitionRepo.findById as vi.Mock).mockResolvedValue({
        id: mockDefinitionId,
        skill_id: mockSkillId,
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

      const input = {
        skillDefinitionId: mockDefinitionId,
        version: '1.0.0',
        sourceType: 'anthropic' as const,
      }

      await skillInstallService.installSkillPackage(mockUserId, input)

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
