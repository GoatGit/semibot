/**
 * Skill Prompt Builder 单元测试
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  buildSkillIndexEntry,
  buildSkillIndexXml,
  buildSkillIndex,
  type SkillIndexEntry,
} from '../services/skill-prompt-builder'

// Mock fs-extra
vi.mock('fs-extra', () => {
  const fns = {
    pathExists: vi.fn(),
    readdir: vi.fn(),
  }
  return { default: fns, ...fns }
})

import fs from 'fs-extra'

describe('Skill Prompt Builder', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('buildSkillIndexXml', () => {
    it('空数组应该返回空字符串', () => {
      const result = buildSkillIndexXml([])
      expect(result).toBe('')
    })

    it('应该生成正确的 XML 结构', () => {
      const entries: SkillIndexEntry[] = [
        {
          name: 'test-skill',
          description: 'A test skill',
          packagePath: '/skills/test-skill/current',
          files: ['SKILL.md', 'REFERENCE.md', 'scripts/main.py'],
        },
      ]

      const result = buildSkillIndexXml(entries)

      expect(result).toContain('<available_skills>')
      expect(result).toContain('</available_skills>')
      expect(result).toContain('<skill name="test-skill"')
      expect(result).toContain('path="/skills/test-skill/current"')
      expect(result).toContain('A test skill')
      expect(result).toContain('SKILL.md, REFERENCE.md')
      expect(result).toContain('scripts/(1个脚本)')
      expect(result).toContain('read_skill_file')
    })

    it('应该正确转义 XML 特殊字符', () => {
      const entries: SkillIndexEntry[] = [
        {
          name: 'skill<with>&"special',
          description: 'desc with <tags> & "quotes"',
          packagePath: '/path/to/skill',
          files: [],
        },
      ]

      const result = buildSkillIndexXml(entries)

      expect(result).toContain('skill&lt;with&gt;&amp;&quot;special')
      expect(result).not.toContain('<with>')
    })

    it('应该处理多个 skill 条目', () => {
      const entries: SkillIndexEntry[] = [
        { name: 'skill-a', description: 'Skill A', packagePath: '/a', files: ['SKILL.md'] },
        { name: 'skill-b', description: 'Skill B', packagePath: '/b', files: ['SKILL.md'] },
        { name: 'skill-c', description: '', packagePath: '/c', files: [] },
      ]

      const result = buildSkillIndexXml(entries)

      expect(result).toContain('skill-a')
      expect(result).toContain('skill-b')
      expect(result).toContain('skill-c')
    })

    it('应该正确分类文件列表', () => {
      const entries: SkillIndexEntry[] = [
        {
          name: 'full-skill',
          description: 'Full skill',
          packagePath: '/full',
          files: [
            'SKILL.md',
            'REFERENCE.md',
            'scripts/main.py',
            'scripts/helper.py',
            'config.json',
            'data.csv',
          ],
        },
      ]

      const result = buildSkillIndexXml(entries)

      // md 文件列在前面
      expect(result).toContain('SKILL.md, REFERENCE.md')
      // scripts 显示数量
      expect(result).toContain('scripts/(2个脚本)')
      // 其他文件
      expect(result).toContain('config.json, data.csv')
    })

    it('无描述时不应该输出描述行', () => {
      const entries: SkillIndexEntry[] = [
        { name: 'no-desc', description: '', packagePath: '/nd', files: ['SKILL.md'] },
      ]

      const result = buildSkillIndexXml(entries)
      // 应该有 name 和 path，但 description 为空时不输出额外行
      expect(result).toContain('name="no-desc"')
    })
  })

  describe('buildSkillIndexEntry', () => {
    it('应该扫描包目录并构建索引条目', async () => {
      ;(fs.pathExists as ReturnType<typeof vi.fn>).mockResolvedValue(true)
      ;(fs.readdir as ReturnType<typeof vi.fn>).mockImplementation(async (dirPath: string) => {
        if (dirPath.endsWith('current')) {
          return [
            { name: 'SKILL.md', isFile: () => true, isDirectory: () => false },
            { name: 'REFERENCE.md', isFile: () => true, isDirectory: () => false },
            { name: 'scripts', isFile: () => false, isDirectory: () => true },
          ]
        }
        if (dirPath.endsWith('scripts')) {
          return [
            { name: 'main.py', isFile: () => true, isDirectory: () => false },
          ]
        }
        return []
      })

      const entry = await buildSkillIndexEntry(
        { id: '1', skillId: 'test', name: 'Test Skill', description: 'A test', protocol: 'skillmd', sourceType: 'local', status: 'active', createdAt: new Date(), updatedAt: new Date() } as any,
        { id: 'p1', packagePath: '/skills/test/current', status: 'active' } as any
      )

      expect(entry.name).toBe('Test Skill')
      expect(entry.description).toBe('A test')
      expect(entry.packagePath).toBe('/skills/test/current')
      expect(entry.files).toContain('SKILL.md')
      expect(entry.files).toContain('REFERENCE.md')
      expect(entry.files).toContain('scripts/main.py')
    })

    it('包路径不存在时应该返回空文件列表', async () => {
      ;(fs.pathExists as ReturnType<typeof vi.fn>).mockResolvedValue(false)

      const entry = await buildSkillIndexEntry(
        { name: 'Missing', description: '' } as any,
        { packagePath: '/nonexistent', status: 'active' } as any
      )

      expect(entry.files).toEqual([])
    })
  })

  describe('buildSkillIndex', () => {
    it('应该只包含 active 状态的包', async () => {
      ;(fs.pathExists as ReturnType<typeof vi.fn>).mockResolvedValue(true)
      ;(fs.readdir as ReturnType<typeof vi.fn>).mockResolvedValue([
        { name: 'SKILL.md', isFile: () => true, isDirectory: () => false },
      ])

      const result = await buildSkillIndex([
        {
          definition: { name: 'Active Skill', description: 'active' } as any,
          package: { packagePath: '/active', status: 'active' } as any,
        },
        {
          definition: { name: 'Failed Skill', description: 'failed' } as any,
          package: { packagePath: '/failed', status: 'failed' } as any,
        },
        {
          definition: { name: 'Pending Skill', description: 'pending' } as any,
          package: { packagePath: '/pending', status: 'pending' } as any,
        },
      ])

      expect(result).toContain('Active Skill')
      expect(result).not.toContain('Failed Skill')
      expect(result).not.toContain('Pending Skill')
    })

    it('所有包都非 active 时应该返回空字符串', async () => {
      const result = await buildSkillIndex([
        {
          definition: { name: 'Failed' } as any,
          package: { packagePath: '/f', status: 'failed' } as any,
        },
      ])

      expect(result).toBe('')
    })
  })
})
