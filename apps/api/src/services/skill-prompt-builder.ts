/**
 * Skill Prompt Builder
 *
 * 构建 skill 索引 XML，注入到 system prompt 中
 * 实现懒加载阶段 1：轻量索引注入
 */

import fs from 'fs-extra'
import * as path from 'path'
import type { SkillDefinition } from '../repositories/skill-definition.repository'
import type { SkillPackage } from '../repositories/skill-package.repository'

// ═══════════════════════════════════════════════════════════════
// 类型定义
// ═══════════════════════════════════════════════════════════════

export interface SkillIndexEntry {
  name: string
  description: string
  packagePath: string
  files: string[]
}

// ═══════════════════════════════════════════════════════════════
// 索引构建
// ═══════════════════════════════════════════════════════════════

/**
 * 扫描 skill 包目录，列出关键文件
 */
async function listSkillFiles(packagePath: string): Promise<string[]> {
  const files: string[] = []

  if (!(await fs.pathExists(packagePath))) {
    return files
  }

  const entries = await fs.readdir(packagePath, { withFileTypes: true })

  for (const entry of entries) {
    if (entry.isFile()) {
      // 顶层文件（SKILL.md, REFERENCE.md, etc.）
      files.push(entry.name)
    } else if (entry.isDirectory() && entry.name === 'scripts') {
      // scripts/ 目录下的文件
      const scriptsDir = path.join(packagePath, 'scripts')
      const scriptEntries = await fs.readdir(scriptsDir, { withFileTypes: true })
      const scriptFiles = scriptEntries
        .filter((e) => e.isFile())
        .map((e) => `scripts/${e.name}`)
      files.push(...scriptFiles)
    }
  }

  return files
}

/**
 * 构建单个 skill 的文件摘要
 */
function formatFileList(files: string[]): string {
  const mdFiles = files.filter((f) => f.endsWith('.md'))
  const scriptFiles = files.filter((f) => f.startsWith('scripts/'))
  const otherFiles = files.filter((f) => !f.endsWith('.md') && !f.startsWith('scripts/'))

  const parts: string[] = []

  if (mdFiles.length > 0) {
    parts.push(mdFiles.join(', '))
  }

  if (scriptFiles.length > 0) {
    parts.push(`scripts/(${scriptFiles.length}个脚本)`)
  }

  if (otherFiles.length > 0) {
    parts.push(otherFiles.join(', '))
  }

  return parts.join(', ')
}

/**
 * 构建 skill 索引条目
 */
export async function buildSkillIndexEntry(
  definition: SkillDefinition,
  pkg: SkillPackage
): Promise<SkillIndexEntry> {
  const files = await listSkillFiles(pkg.packagePath)

  return {
    name: definition.name,
    description: definition.description || '',
    packagePath: pkg.packagePath,
    files,
  }
}

/**
 * 构建 skill 索引 XML（注入到 system prompt）
 */
export function buildSkillIndexXml(entries: SkillIndexEntry[]): string {
  if (entries.length === 0) {
    return ''
  }

  const skillTags = entries.map((entry) => {
    const fileList = formatFileList(entry.files)
    const desc = entry.description ? `\n    ${entry.description}` : ''
    const files = fileList ? `\n    文件: ${fileList}` : ''

    return `  <skill name="${escapeXml(entry.name)}" path="${escapeXml(entry.packagePath)}">${desc}${files}\n  </skill>`
  })

  return `<available_skills>
${skillTags.join('\n')}
</available_skills>

当任务匹配某个技能时，先用 read_skill_file 工具读取对应的 SKILL.md 获取完整指南。
如需执行技能中的脚本，使用 bash 工具运行。脚本位于技能目录的 scripts/ 下。`
}

/**
 * 构建完整的 skill 索引（从 definition + package 列表）
 */
export async function buildSkillIndex(
  skills: Array<{ definition: SkillDefinition; package: SkillPackage }>
): Promise<string> {
  const entries: SkillIndexEntry[] = []

  for (const { definition, package: pkg } of skills) {
    if (pkg.status === 'active') {
      const entry = await buildSkillIndexEntry(definition, pkg)
      entries.push(entry)
    }
  }

  return buildSkillIndexXml(entries)
}

// ═══════════════════════════════════════════════════════════════
// 辅助函数
// ═══════════════════════════════════════════════════════════════

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
