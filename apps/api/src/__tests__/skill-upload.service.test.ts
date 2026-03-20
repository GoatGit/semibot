/**
 * Skill Upload Service 单元测试
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock dependencies BEFORE importing the module
vi.mock('fs-extra', () => {
  const fns = {
    pathExists: vi.fn(),
    remove: vi.fn(),
  }
  return { default: fns, ...fns }
})

vi.mock('fs/promises', () => ({
  readdir: vi.fn(),
  stat: vi.fn(),
}))

vi.mock('../utils/archive-extractor', () => ({
  extractArchive: vi.fn(),
  findPackageRoot: vi.fn(),
}))

vi.mock('../services/skill-install.service', () => ({
  installSkillPackage: vi.fn(),
}))

vi.mock('../services/skill-retry-rollback.service', () => ({
  installWithRetry: vi.fn(),
}))

vi.mock('../lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}))

import fs from 'fs-extra'
import { readdir, stat } from 'fs/promises'
import { extractArchive, findPackageRoot } from '../utils/archive-extractor'
import { installSkillPackage } from '../services/skill-install.service'
import { installWithRetry } from '../services/skill-retry-rollback.service'
import { uploadAndInstall } from '../services/skill-upload.service'

describe('Skill Upload Service', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('uploadAndInstall', () => {
    const baseInput = {
      skillDefinitionId: 'def-123',
      tempFilePath: '/tmp/upload-abc.tar.gz',
      originalName: 'my-skill.tar.gz',
    }

    function setupSuccessMocks() {
      ;(extractArchive as ReturnType<typeof vi.fn>).mockResolvedValue(undefined)
      ;(findPackageRoot as ReturnType<typeof vi.fn>).mockResolvedValue('/tmp/extract-xxx/my-skill')
      ;(readdir as ReturnType<typeof vi.fn>).mockResolvedValue([
        { name: 'SKILL.md', isDirectory: () => false },
      ])
      ;(stat as ReturnType<typeof vi.fn>).mockResolvedValue({ size: 1024 })
      ;(installSkillPackage as ReturnType<typeof vi.fn>).mockResolvedValue('pkg-123')
      ;(fs.pathExists as ReturnType<typeof vi.fn>).mockResolvedValue(true)
      ;(fs.remove as ReturnType<typeof vi.fn>).mockResolvedValue(undefined)
    }

    it('应该成功上传并安装技能包', async () => {
      setupSuccessMocks()

      const result = await uploadAndInstall(baseInput)

      expect(result).toBe('pkg-123')
      expect(extractArchive).toHaveBeenCalledWith(
        baseInput.tempFilePath,
        expect.stringContaining('extract-')
      )
      expect(findPackageRoot).toHaveBeenCalled()
      expect(installSkillPackage).toHaveBeenCalledWith(
        expect.objectContaining({
          skillDefinitionId: 'def-123',
          sourceType: 'upload',
        })
      )
    })

    it('启用重试时应该使用 installWithRetry', async () => {
      setupSuccessMocks()
      ;(installWithRetry as ReturnType<typeof vi.fn>).mockResolvedValue('pkg-retry')

      const result = await uploadAndInstall({ ...baseInput, enableRetry: true })

      expect(result).toBe('pkg-retry')
      expect(installWithRetry).toHaveBeenCalled()
      expect(installSkillPackage).not.toHaveBeenCalled()
    })

    it('应该在完成后清理临时文件', async () => {
      setupSuccessMocks()

      await uploadAndInstall(baseInput)

      // 应该清理解压目录和原始压缩文件
      expect(fs.remove).toHaveBeenCalledTimes(2)
    })

    it('安装失败时也应该清理临时文件', async () => {
      ;(extractArchive as ReturnType<typeof vi.fn>).mockResolvedValue(undefined)
      ;(findPackageRoot as ReturnType<typeof vi.fn>).mockResolvedValue('/tmp/extract-xxx/my-skill')
      ;(readdir as ReturnType<typeof vi.fn>).mockResolvedValue([
        { name: 'SKILL.md', isDirectory: () => false },
      ])
      ;(stat as ReturnType<typeof vi.fn>).mockResolvedValue({ size: 1024 })
      ;(installSkillPackage as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Install failed'))
      ;(fs.pathExists as ReturnType<typeof vi.fn>).mockResolvedValue(true)
      ;(fs.remove as ReturnType<typeof vi.fn>).mockResolvedValue(undefined)

      await expect(uploadAndInstall(baseInput)).rejects.toThrow('Install failed')

      // 即使失败也应该清理
      expect(fs.remove).toHaveBeenCalled()
    })

    it('解压失败时应该抛出错误并清理', async () => {
      ;(extractArchive as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Invalid archive'))
      ;(fs.pathExists as ReturnType<typeof vi.fn>).mockResolvedValue(true)
      ;(fs.remove as ReturnType<typeof vi.fn>).mockResolvedValue(undefined)

      await expect(uploadAndInstall(baseInput)).rejects.toThrow('Invalid archive')

      expect(fs.remove).toHaveBeenCalled()
    })

    it('解压后大小超限时应该拒绝', async () => {
      ;(extractArchive as ReturnType<typeof vi.fn>).mockResolvedValue(undefined)
      ;(findPackageRoot as ReturnType<typeof vi.fn>).mockResolvedValue('/tmp/extract-xxx/big-skill')
      // 模拟大量文件，总大小超过限制
      ;(readdir as ReturnType<typeof vi.fn>).mockResolvedValue([
        { name: 'huge-file.bin', isDirectory: () => false },
      ])
      ;(stat as ReturnType<typeof vi.fn>).mockResolvedValue({ size: 200 * 1024 * 1024 }) // 200MB
      ;(fs.pathExists as ReturnType<typeof vi.fn>).mockResolvedValue(true)
      ;(fs.remove as ReturnType<typeof vi.fn>).mockResolvedValue(undefined)

      await expect(uploadAndInstall(baseInput)).rejects.toThrow('超过限制')
    })
  })
})
