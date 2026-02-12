/**
 * Skill File Service
 *
 * 实现 read_skill_file 工具，支持 LLM 按需读取 skill 文件
 * 懒加载阶段 2：按需读取
 */

import fs from 'fs-extra'
import * as path from 'path'
import { createLogger } from '../lib/logger'

const logger = createLogger('skill-file')

// ═══════════════════════════════════════════════════════════════
// read_skill_file 工具定义
// ═══════════════════════════════════════════════════════════════

export const READ_SKILL_FILE_TOOL = {
  type: 'function' as const,
  function: {
    name: 'read_skill_file',
    description: '读取已安装技能的文件内容。用于获取技能的完整指南、参考文档或查看脚本。',
    parameters: {
      type: 'object',
      properties: {
        skill_name: {
          type: 'string',
          description: '技能名称（与 available_skills 中的 name 对应）',
        },
        file_path: {
          type: 'string',
          description: '要读取的文件路径（相对于技能目录），如 SKILL.md、REFERENCE.md、scripts/main.py',
        },
      },
      required: ['skill_name', 'file_path'],
    },
  },
}

// ═══════════════════════════════════════════════════════════════
// 类型定义
// ═══════════════════════════════════════════════════════════════

export interface SkillFileMap {
  [skillName: string]: string // skillName -> packagePath
}

// ═══════════════════════════════════════════════════════════════
// 核心功能
// ═══════════════════════════════════════════════════════════════

/**
 * 读取 skill 文件内容
 *
 * 安全约束：
 * - 只能读取 skillFileMap 中已注册的 skill
 * - file_path 必须是相对路径，不能包含 ..
 * - 解析后的绝对路径必须在 packagePath 内
 */
export async function readSkillFile(
  skillName: string,
  filePath: string,
  skillFileMap: SkillFileMap
): Promise<string> {
  // 1. 查找 skill 的包路径
  const packagePath = skillFileMap[skillName]
  if (!packagePath) {
    return `错误: 未找到技能 "${skillName}"。可用技能: ${Object.keys(skillFileMap).join(', ') || '无'}`
  }

  // 2. 安全校验：拒绝绝对路径和路径穿越
  if (path.isAbsolute(filePath)) {
    logger.warn('拒绝绝对路径', { skillName, filePath })
    return '错误: file_path 必须是相对路径'
  }

  if (filePath.includes('..')) {
    logger.warn('拒绝路径穿越', { skillName, filePath })
    return '错误: file_path 不能包含 ..'
  }

  // 3. 解析并验证最终路径
  const resolvedPath = path.resolve(packagePath, filePath)
  const normalizedPackagePath = path.resolve(packagePath)

  if (!resolvedPath.startsWith(normalizedPackagePath + path.sep) && resolvedPath !== normalizedPackagePath) {
    logger.warn('路径穿越检测', { skillName, filePath, resolvedPath, packagePath })
    return '错误: 文件路径超出技能目录范围'
  }

  // 4. 读取文件
  if (!(await fs.pathExists(resolvedPath))) {
    // 列出可用文件帮助 LLM
    const availableFiles = await listAvailableFiles(packagePath)
    return `错误: 文件 "${filePath}" 不存在。可用文件: ${availableFiles.join(', ') || '无'}`
  }

  const stats = await fs.stat(resolvedPath)
  if (!stats.isFile()) {
    return `错误: "${filePath}" 不是文件`
  }

  // 5. 限制文件大小（最大 1MB）
  const MAX_FILE_SIZE = 1024 * 1024
  if (stats.size > MAX_FILE_SIZE) {
    return `错误: 文件过大 (${(stats.size / 1024).toFixed(1)}KB)，最大支持 1MB`
  }

  try {
    const content = await fs.readFile(resolvedPath, 'utf-8')
    logger.info('读取 skill 文件', { skillName, filePath, size: stats.size })
    return content
  } catch (error) {
    logger.error('读取文件失败', error as Error, { skillName, filePath })
    return `错误: 读取文件失败: ${(error as Error).message}`
  }
}

/**
 * 列出 skill 目录中的可用文件
 */
async function listAvailableFiles(packagePath: string): Promise<string[]> {
  const files: string[] = []

  if (!(await fs.pathExists(packagePath))) {
    return files
  }

  const entries = await fs.readdir(packagePath, { withFileTypes: true })

  for (const entry of entries) {
    if (entry.isFile()) {
      files.push(entry.name)
    } else if (entry.isDirectory() && entry.name === 'scripts') {
      const scriptsDir = path.join(packagePath, 'scripts')
      const scriptEntries = await fs.readdir(scriptsDir, { withFileTypes: true })
      for (const se of scriptEntries) {
        if (se.isFile()) {
          files.push(`scripts/${se.name}`)
        }
      }
    }
  }

  return files
}

/**
 * 从 definition + package 列表构建 SkillFileMap
 */
export function buildSkillFileMap(
  skills: Array<{ name: string; packagePath: string }>
): SkillFileMap {
  const map: SkillFileMap = {}
  for (const skill of skills) {
    map[skill.name] = skill.packagePath
  }
  return map
}
