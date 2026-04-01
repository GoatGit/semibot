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
  whenToUse: string
  executionContext?: string
  effort?: string
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

async function readFrontmatterFields(packagePath: string): Promise<{
  whenToUse: string
  executionContext?: string
  effort?: string
}> {
  const skillPath = path.join(packagePath, 'SKILL.md')
  if (!(await fs.pathExists(skillPath))) {
    return { whenToUse: '' }
  }
  let raw = ''
  try {
    raw = await fs.readFile(skillPath, 'utf8')
  } catch {
    return { whenToUse: '' }
  }
  const lines = raw.split(/\r?\n/)
  if (lines[0]?.trim() !== '---') {
    return { whenToUse: '' }
  }
  const end = lines.findIndex((line, idx) => idx > 0 && line.trim() === '---')
  if (end <= 0) {
    return { whenToUse: '' }
  }
  const frontmatter = lines.slice(1, end)
  const fields = {
    whenToUse: '',
    executionContext: undefined as string | undefined,
    effort: undefined as string | undefined,
  }
  for (const line of frontmatter) {
    const match = line.match(/^\s*([A-Za-z0-9_-]+)\s*:\s*(.+?)\s*$/)
    if (!match) continue
    const key = match[1]
    const value = match[2].replace(/^['"]|['"]$/g, '').trim()
    if (key === 'when_to_use') fields.whenToUse = value
    if (key === 'context') fields.executionContext = value
    if (key === 'effort') fields.effort = value
  }
  return fields
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
  const frontmatter = await readFrontmatterFields(pkg.packagePath)

  return {
    name: definition.name,
    description: definition.description || '',
    whenToUse: frontmatter.whenToUse,
    executionContext: frontmatter.executionContext,
    effort: frontmatter.effort,
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
    const whenToUse = entry.whenToUse ? `\n    when_to_use: ${entry.whenToUse}` : ''
    const executionContext = entry.executionContext ? `\n    execution_context: ${entry.executionContext}` : ''
    const effort = entry.effort ? `\n    effort: ${entry.effort}` : ''
    const files = fileList ? `\n    文件: ${fileList}` : ''

    return `  <skill name="${escapeXml(entry.name)}" scope="skill" path="${escapeXml(entry.packagePath)}">${desc}${whenToUse}${executionContext}${effort}${files}\n  </skill>`
  })

  return `<available_skills>
${skillTags.join('\n')}
</available_skills>

技能使用说明：
- 上述技能不是独立的工具，不能直接作为工具名调用。
- 第一步先用 "file_io" 读取该技能的 SKILL.md：action="read", path="skills/<skill_name>/SKILL.md"。
- file_io 只面向当前会话工作目录；技能资源会被 runtime 映射到 skills/<skill_name>/...，生成产物与技能文件都走同一套路径语义。
- 读取 SKILL.md 后，再根据其中要求决定是否调用 "code_executor" 执行代码（例如运行 scripts/ 中脚本）。
- 默认主报告先生成 markdown/text；HTML/PDF 仅作为派生产物与最终分发格式。
- 切记：plan 中的 tool 字段只能填写 Available tools 列表中的工具名（如 "file_io"、"code_executor"、"tavily-search" 等）。`
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
