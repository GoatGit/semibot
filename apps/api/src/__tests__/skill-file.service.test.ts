/**
 * Skill File Service 单元测试
 *
 * 测试 read_skill_file 工具的安全性和功能
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readSkillFile, buildSkillFileMap, READ_SKILL_FILE_TOOL } from '../services/skill-file.service'
import type { SkillFileMap } from '../services/skill-file.service'

// Mock fs-extra
vi.mock('fs-extra', () => {
  const fns = {
    pathExists: vi.fn(),
    readFile: vi.fn(),
    stat: vi.fn(),
    readdir: vi.fn(),
  }
  return { default: fns, ...fns }
})

// Mock logger
vi.mock('../lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}))

import fs from 'fs-extra'

describe('Skill File Service', () => {
  const skillFileMap: SkillFileMap = {
    'test-skill': '/var/lib/semibot/skills/test-skill/current',
    'another-skill': '/var/lib/semibot/skills/another-skill/current',
  }

  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('READ_SKILL_FILE_TOOL', () => {
    it('应该有正确的工具定义结构', () => {
      expect(READ_SKILL_FILE_TOOL.type).toBe('function')
      expect(READ_SKILL_FILE_TOOL.function.name).toBe('read_skill_file')
      expect(READ_SKILL_FILE_TOOL.function.parameters.required).toContain('skill_name')
      expect(READ_SKILL_FILE_TOOL.function.parameters.required).toContain('file_path')
    })
  })

  describe('readSkillFile', () => {
    it('应该成功读取存在的文件', async () => {
      ;(fs.pathExists as ReturnType<typeof vi.fn>).mockResolvedValue(true)
      ;(fs.stat as ReturnType<typeof vi.fn>).mockResolvedValue({ isFile: () => true, size: 100 })
      ;(fs.readFile as ReturnType<typeof vi.fn>).mockResolvedValue('# Test Skill\nHello world')

      const result = await readSkillFile('test-skill', 'SKILL.md', skillFileMap)

      expect(result).toBe('# Test Skill\nHello world')
    })

    it('应该读取 scripts 子目录中的文件', async () => {
      ;(fs.pathExists as ReturnType<typeof vi.fn>).mockResolvedValue(true)
      ;(fs.stat as ReturnType<typeof vi.fn>).mockResolvedValue({ isFile: () => true, size: 50 })
      ;(fs.readFile as ReturnType<typeof vi.fn>).mockResolvedValue('print("hello")')

      const result = await readSkillFile('test-skill', 'scripts/main.py', skillFileMap)

      expect(result).toBe('print("hello")')
    })

    // 安全性测试
    it('应该拒绝未注册的 skill 名称', async () => {
      const result = await readSkillFile('unknown-skill', 'SKILL.md', skillFileMap)

      expect(result).toContain('错误')
      expect(result).toContain('未找到技能')
      expect(result).toContain('unknown-skill')
    })

    it('应该拒绝绝对路径', async () => {
      const result = await readSkillFile('test-skill', '/etc/passwd', skillFileMap)

      expect(result).toContain('错误')
      expect(result).toContain('相对路径')
    })

    it('应该拒绝路径穿越 (..)', async () => {
      const result = await readSkillFile('test-skill', '../../../etc/passwd', skillFileMap)

      expect(result).toContain('错误')
      expect(result).toContain('..')
    })

    it('应该拒绝隐蔽的路径穿越', async () => {
      const result = await readSkillFile('test-skill', 'scripts/../../etc/passwd', skillFileMap)

      expect(result).toContain('错误')
    })

    it('应该在文件不存在时列出可用文件', async () => {
      ;(fs.pathExists as ReturnType<typeof vi.fn>).mockImplementation(async (p: string) => {
        if (p.endsWith('current')) return true
        if (p.endsWith('nonexistent.md')) return false
        return true
      })
      ;(fs.readdir as ReturnType<typeof vi.fn>).mockResolvedValue([
        { name: 'SKILL.md', isFile: () => true, isDirectory: () => false },
        { name: 'README.md', isFile: () => true, isDirectory: () => false },
      ])

      const result = await readSkillFile('test-skill', 'nonexistent.md', skillFileMap)

      expect(result).toContain('错误')
      expect(result).toContain('不存在')
      expect(result).toContain('SKILL.md')
    })

    it('应该拒绝非文件（目录）', async () => {
      ;(fs.pathExists as ReturnType<typeof vi.fn>).mockResolvedValue(true)
      ;(fs.stat as ReturnType<typeof vi.fn>).mockResolvedValue({ isFile: () => false, size: 0 })

      const result = await readSkillFile('test-skill', 'scripts', skillFileMap)

      expect(result).toContain('错误')
      expect(result).toContain('不是文件')
    })

    it('应该拒绝超过 1MB 的文件', async () => {
      ;(fs.pathExists as ReturnType<typeof vi.fn>).mockResolvedValue(true)
      ;(fs.stat as ReturnType<typeof vi.fn>).mockResolvedValue({
        isFile: () => true,
        size: 2 * 1024 * 1024, // 2MB
      })

      const result = await readSkillFile('test-skill', 'large-file.bin', skillFileMap)

      expect(result).toContain('错误')
      expect(result).toContain('文件过大')
      expect(result).toContain('1MB')
    })

    it('应该处理读取文件时的异常', async () => {
      ;(fs.pathExists as ReturnType<typeof vi.fn>).mockResolvedValue(true)
      ;(fs.stat as ReturnType<typeof vi.fn>).mockResolvedValue({ isFile: () => true, size: 100 })
      ;(fs.readFile as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Permission denied'))

      const result = await readSkillFile('test-skill', 'SKILL.md', skillFileMap)

      expect(result).toContain('错误')
      expect(result).toContain('读取文件失败')
    })

    it('空 skillFileMap 时应该返回错误', async () => {
      const result = await readSkillFile('test-skill', 'SKILL.md', {})

      expect(result).toContain('错误')
      expect(result).toContain('未找到技能')
    })
  })

  describe('buildSkillFileMap', () => {
    it('应该正确构建映射', () => {
      const skills = [
        { name: 'skill-a', packagePath: '/path/a' },
        { name: 'skill-b', packagePath: '/path/b' },
      ]

      const map = buildSkillFileMap(skills)

      expect(map['skill-a']).toBe('/path/a')
      expect(map['skill-b']).toBe('/path/b')
    })

    it('空数组应该返回空映射', () => {
      const map = buildSkillFileMap([])
      expect(Object.keys(map)).toHaveLength(0)
    })

    it('重复名称应该使用最后一个', () => {
      const skills = [
        { name: 'dup', packagePath: '/first' },
        { name: 'dup', packagePath: '/second' },
      ]

      const map = buildSkillFileMap(skills)

      expect(map['dup']).toBe('/second')
    })
  })
})
