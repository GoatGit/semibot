/**
 * Skill Validator 单元测试 (SKILL.md 模式)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs-extra'
import * as path from 'path'
import * as os from 'os'
import {
  parseSkillMd,
  validatePackageStructure,
  calculateFileSHA256,
  calculateDirectorySHA256,
  validateSkillPackage,
  SkillMdFrontmatterSchema,
} from '../utils/skill-validator'

describe('Skill Validator', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-test-'))
  })

  afterEach(async () => {
    await fs.remove(tempDir)
  })

  describe('SkillMdFrontmatterSchema', () => {
    it('应该验证有效的 frontmatter', () => {
      const frontmatter = {
        skill_id: 'test-skill',
        name: 'Test Skill',
        description: 'A test skill',
        trigger_keywords: ['test', 'demo'],
      }

      const result = SkillMdFrontmatterSchema.parse(frontmatter)

      expect(result.skill_id).toBe('test-skill')
      expect(result.name).toBe('Test Skill')
    })

    it('应该拒绝缺少必需字段的 frontmatter', () => {
      const frontmatter = {
        skill_id: 'test-skill',
      }

      expect(() => SkillMdFrontmatterSchema.parse(frontmatter)).toThrow()
    })

    it('应该拒绝无效的 skill_id 格式', () => {
      const frontmatter = {
        skill_id: 'invalid skill id!',
        name: 'Test Skill',
      }

      expect(() => SkillMdFrontmatterSchema.parse(frontmatter)).toThrow()
    })

    it('应该接受有效的 skill_id 格式', () => {
      const validIds = ['test-skill', 'my-org/my-skill', 'skill_v2', 'a.b:c/d']

      validIds.forEach((id) => {
        const frontmatter = { skill_id: id, name: 'Test' }
        const result = SkillMdFrontmatterSchema.parse(frontmatter)
        expect(result.skill_id).toBe(id)
      })
    })

    it('应该验证可选字段', () => {
      const frontmatter = {
        skill_id: 'test-skill',
        name: 'Test Skill',
        description: 'A test skill',
        trigger_keywords: ['test'],
        author: 'Test Author',
        homepage: 'https://example.com',
        documentation: 'https://docs.example.com',
        category: 'productivity',
        tags: ['test', 'demo'],
        icon_url: 'https://example.com/icon.png',
      }

      const result = SkillMdFrontmatterSchema.parse(frontmatter)

      expect(result.description).toBe('A test skill')
      expect(result.author).toBe('Test Author')
      expect(result.category).toBe('productivity')
      expect(result.tags).toEqual(['test', 'demo'])
    })

    it('应该限制字段长度', () => {
      const frontmatter = {
        skill_id: 'a'.repeat(121), // 超过 120
        name: 'Test Skill',
      }

      expect(() => SkillMdFrontmatterSchema.parse(frontmatter)).toThrow()
    })

    it('应该限制数组大小', () => {
      const frontmatter = {
        skill_id: 'test-skill',
        name: 'Test Skill',
        trigger_keywords: Array(21).fill('keyword'), // 超过 20
      }

      expect(() => SkillMdFrontmatterSchema.parse(frontmatter)).toThrow()
    })
  })

  describe('parseSkillMd', () => {
    it('应该解析有效的 SKILL.md', async () => {
      const skillMd = `---
skill_id: test-skill
name: Test Skill
description: A test skill
---

# Test Skill

This is a test skill.
`
      await fs.writeFile(path.join(tempDir, 'SKILL.md'), skillMd)

      const result = await parseSkillMd(path.join(tempDir, 'SKILL.md'))

      expect(result.frontmatter.skill_id).toBe('test-skill')
      expect(result.frontmatter.name).toBe('Test Skill')
      expect(result.content).toContain('# Test Skill')
    })

    it('应该拒绝不存在的文件', async () => {
      await expect(parseSkillMd(path.join(tempDir, 'SKILL.md'))).rejects.toThrow('not found')
    })

    it('应该��绝空文件', async () => {
      await fs.writeFile(path.join(tempDir, 'SKILL.md'), '')

      await expect(parseSkillMd(path.join(tempDir, 'SKILL.md'))).rejects.toThrow('empty')
    })

    it('应该拒绝无效的 frontmatter', async () => {
      const skillMd = `---
invalid_field: true
---

# Test
`
      await fs.writeFile(path.join(tempDir, 'SKILL.md'), skillMd)

      await expect(parseSkillMd(path.join(tempDir, 'SKILL.md'))).rejects.toThrow('validation failed')
    })
  })

  describe('validatePackageStructure', () => {
    it('应该验证有效的包结构', async () => {
      const skillMd = `---
skill_id: test-skill
name: Test Skill
---

# Test Skill
`
      await fs.writeFile(path.join(tempDir, 'SKILL.md'), skillMd)

      const result = await validatePackageStructure(tempDir)

      expect(result.valid).toBe(true)
      expect(result.errors).toHaveLength(0)
      expect(result.details.hasSkillMd).toBe(true)
    })

    it('应该检测缺少 SKILL.md', async () => {
      // 空目录
      const result = await validatePackageStructure(tempDir)

      expect(result.valid).toBe(false)
      expect(result.errors).toContain('Missing required file: SKILL.md')
    })

    it('应该警告存在 manifest.json', async () => {
      const skillMd = `---
skill_id: test-skill
name: Test Skill
---

# Test Skill
`
      await fs.writeFile(path.join(tempDir, 'SKILL.md'), skillMd)
      await fs.writeJson(path.join(tempDir, 'manifest.json'), { test: 'data' })

      const result = await validatePackageStructure(tempDir)

      expect(result.warnings.some((w) => w.includes('manifest.json is deprecated'))).toBe(true)
    })

    it('应该检测 scripts 目录', async () => {
      const skillMd = `---
skill_id: test-skill
name: Test Skill
---

# Test Skill
`
      await fs.writeFile(path.join(tempDir, 'SKILL.md'), skillMd)
      await fs.ensureDir(path.join(tempDir, 'scripts'))
      await fs.writeFile(path.join(tempDir, 'scripts', 'main.py'), 'print("hello")')

      const result = await validatePackageStructure(tempDir)

      expect(result.details.hasScripts).toBe(true)
      expect(result.details.entryFile).toBe('scripts/main.py')
    })

    it('应该推断入口文件', async () => {
      const entryFiles = ['main.py', 'main.js', 'main.ts', 'index.py', 'index.js']

      for (const file of entryFiles) {
        const testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-entry-'))
        const skillMd = `---
skill_id: test-skill
name: Test
---

# Test
`
        await fs.writeFile(path.join(testDir, 'SKILL.md'), skillMd)
        await fs.ensureDir(path.join(testDir, 'scripts'))
        await fs.writeFile(path.join(testDir, 'scripts', file), 'content')

        const result = await validatePackageStructure(testDir)

        expect(result.details.entryFile).toBe(`scripts/${file}`)

        await fs.remove(testDir)
      }
    })

    it('应该检测 references 和 assets 目录', async () => {
      const skillMd = `---
skill_id: test-skill
name: Test Skill
---

# Test Skill
`
      await fs.writeFile(path.join(tempDir, 'SKILL.md'), skillMd)
      await fs.ensureDir(path.join(tempDir, 'references'))
      await fs.ensureDir(path.join(tempDir, 'assets'))

      const result = await validatePackageStructure(tempDir)

      expect(result.details.hasReferences).toBe(true)
      expect(result.details.hasAssets).toBe(true)
    })

    it('应该计算文件统计信息', async () => {
      const skillMd = `---
skill_id: test-skill
name: Test Skill
---

# Test Skill

Content
`
      await fs.writeFile(path.join(tempDir, 'SKILL.md'), skillMd)

      const result = await validatePackageStructure(tempDir)

      expect(result.details.fileCount).toBeGreaterThan(0)
      expect(result.details.totalSizeBytes).toBeGreaterThan(0)
    })

    it('应该拒绝超大包', async () => {
      const skillMd = `---
skill_id: test-skill
name: Test
---

# Test
`
      await fs.writeFile(path.join(tempDir, 'SKILL.md'), skillMd)

      // 创建一个大文件（模拟超过 100MB）
      const largeContent = Buffer.alloc(101 * 1024 * 1024) // 101MB
      await fs.writeFile(path.join(tempDir, 'large.bin'), largeContent)

      const result = await validatePackageStructure(tempDir)

      expect(result.valid).toBe(false)
      expect(result.errors.some((e) => e.includes('size exceeds limit'))).toBe(true)
    })

    it('应该处理空 SKILL.md', async () => {
      await fs.writeFile(path.join(tempDir, 'SKILL.md'), '')

      const result = await validatePackageStructure(tempDir)

      expect(result.valid).toBe(false)
    })

    it('应该解析 SKILL.md Frontmatter', async () => {
      const skillMd = `---
skill_id: test-skill
name: Test Skill
---

# Test Skill
`
      await fs.writeFile(path.join(tempDir, 'SKILL.md'), skillMd)

      const result = await validatePackageStructure(tempDir)

      expect(result.valid).toBe(true)
    })
  })

  describe('calculateFileSHA256', () => {
    it('应该计算文件 SHA256', async () => {
      const content = 'test content'
      const filePath = path.join(tempDir, 'test.txt')
      await fs.writeFile(filePath, content)

      const hash = await calculateFileSHA256(filePath)

      expect(hash).toMatch(/^[a-f0-9]{64}$/)
      expect(hash.length).toBe(64)
    })

    it('应该对相同内容产生相同哈希', async () => {
      const content = 'test content'
      const file1 = path.join(tempDir, 'test1.txt')
      const file2 = path.join(tempDir, 'test2.txt')

      await fs.writeFile(file1, content)
      await fs.writeFile(file2, content)

      const hash1 = await calculateFileSHA256(file1)
      const hash2 = await calculateFileSHA256(file2)

      expect(hash1).toBe(hash2)
    })

    it('应该对不同内容产生不同哈希', async () => {
      const file1 = path.join(tempDir, 'test1.txt')
      const file2 = path.join(tempDir, 'test2.txt')

      await fs.writeFile(file1, 'content 1')
      await fs.writeFile(file2, 'content 2')

      const hash1 = await calculateFileSHA256(file1)
      const hash2 = await calculateFileSHA256(file2)

      expect(hash1).not.toBe(hash2)
    })
  })

  describe('calculateDirectorySHA256', () => {
    it('应该计算目录 SHA256', async () => {
      await fs.writeFile(path.join(tempDir, 'file1.txt'), 'content 1')
      await fs.writeFile(path.join(tempDir, 'file2.txt'), 'content 2')

      const hash = await calculateDirectorySHA256(tempDir)

      expect(hash).toMatch(/^[a-f0-9]{64}$/)
    })

    it('应该对相同目录结构产生相同哈希', async () => {
      const dir1 = path.join(tempDir, 'dir1')
      const dir2 = path.join(tempDir, 'dir2')

      await fs.ensureDir(dir1)
      await fs.ensureDir(dir2)

      await fs.writeFile(path.join(dir1, 'file.txt'), 'content')
      await fs.writeFile(path.join(dir2, 'file.txt'), 'content')

      const hash1 = await calculateDirectorySHA256(dir1)
      const hash2 = await calculateDirectorySHA256(dir2)

      expect(hash1).toBe(hash2)
    })

    it('应该包含子目录', async () => {
      await fs.ensureDir(path.join(tempDir, 'subdir'))
      await fs.writeFile(path.join(tempDir, 'subdir', 'file.txt'), 'content')

      const hash = await calculateDirectorySHA256(tempDir)

      expect(hash).toMatch(/^[a-f0-9]{64}$/)
    })
  })

  describe('validateSkillPackage', () => {
    it('应该执行完整验证', async () => {
      const skillMd = `---
skill_id: test-skill
name: Test Skill
description: A test skill
---

# Test Skill
`
      await fs.writeFile(path.join(tempDir, 'SKILL.md'), skillMd)
      await fs.ensureDir(path.join(tempDir, 'scripts'))
      await fs.writeFile(path.join(tempDir, 'scripts', 'main.py'), 'print("hello")')

      const result = await validateSkillPackage(tempDir)

      expect(result.valid).toBe(true)
      expect(result.skillMd).toBeDefined()
      expect(result.skillMd?.skill_id).toBe('test-skill')
      expect(result.structure.valid).toBe(true)
      expect(result.checksum).toMatch(/^[a-f0-9]{64}$/)
    })

    it('应该返回所有错误和警告', async () => {
      // 创建不完整的包
      await fs.writeFile(path.join(tempDir, 'SKILL.md'), '')

      const result = await validateSkillPackage(tempDir)

      expect(result.valid).toBe(false)
      expect(result.errors.length + result.warnings.length).toBeGreaterThan(0)
    })
  })

  describe('边界条件', () => {
    it('应该处理不存在的目录', async () => {
      const nonExistentDir = path.join(tempDir, 'non-existent')

      const result = await validatePackageStructure(nonExistentDir)

      expect(result.valid).toBe(false)
      expect(result.errors[0]).toContain('does not exist')
    })

    it('应该处理空目录', async () => {
      const result = await validatePackageStructure(tempDir)

      expect(result.valid).toBe(false)
      expect(result.errors).toContain('Missing required file: SKILL.md')
    })

    it('应该处理特殊字符', () => {
      const frontmatter = {
        skill_id: 'test-skill',
        name: 'Test Skill with 中文 and émojis 🎉',
      }

      const result = SkillMdFrontmatterSchema.parse(frontmatter)

      expect(result.name).toBe(frontmatter.name)
    })
  })
})
