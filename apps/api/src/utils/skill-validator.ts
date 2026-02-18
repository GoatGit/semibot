/**
 * Skills 校验工具 - SKILL.md 模式
 *
 * 统一使用 SKILL.md frontmatter 作为元数据来源
 * 不再支持 manifest.json
 */

import fs from 'fs-extra'
import * as path from 'path'
import { z } from 'zod'
import matter from 'gray-matter'
import { createHash } from 'crypto'

// ═══════════════════════════════════════════════════════════════
// 类型定义
// ═══════════════════════════════════════════════════════════════

/**
 * SKILL.md Frontmatter Schema
 */
export const SkillMdFrontmatterSchema = z.object({
  skill_id: z
    .string()
    .min(1)
    .max(120)
    .regex(/^[a-zA-Z0-9._:/-]+$/, 'skill_id must contain only alphanumeric, dots, colons, slashes, hyphens')
    .optional(),
  name: z.string().min(1).max(100),
  description: z.string().max(1000).optional(),
  trigger_keywords: z.array(z.string().max(50)).max(20).optional(),
  author: z.string().max(100).optional(),
  homepage: z.string().url().optional(),
  documentation: z.string().url().optional(),
  category: z.string().max(50).optional(),
  tags: z.array(z.string().max(30)).max(10).optional(),
  icon_url: z.string().url().optional(),
  license: z.string().max(50).optional(),
  repository: z.string().url().optional(),
  entry: z.string().max(200).optional(),
})

export type SkillMdFrontmatter = z.infer<typeof SkillMdFrontmatterSchema>

/**
 * SKILL.md 解析结果
 */
export interface SkillMdParseResult {
  frontmatter: SkillMdFrontmatter
  content: string
  raw: string
}

/**
 * 目录结构校验结果
 */
export interface ValidationResult {
  valid: boolean
  errors: string[]
  warnings: string[]
  details: {
    hasSkillMd: boolean
    hasScripts: boolean
    hasReferences: boolean
    hasAssets: boolean
    entryFile?: string
    fileCount: number
    totalSizeBytes: number
  }
}

/**
 * 完整校验结果
 */
export interface CompleteValidationResult {
  valid: boolean
  skillMd?: SkillMdFrontmatter
  structure: ValidationResult
  checksum: string
  errors: string[]
  warnings: string[]
}

// ═══════════════════════════════════════════════════════════════
// SKILL.md 解析与校验
// ═══════════════════════════════════════════════════════════════

/**
 * 解析 SKILL.md 文件
 */
export async function parseSkillMd(skillMdPath: string): Promise<SkillMdParseResult> {
  if (!(await fs.pathExists(skillMdPath))) {
    throw new Error(`SKILL.md not found: ${skillMdPath}`)
  }

  const raw = await fs.readFile(skillMdPath, 'utf-8')
  if (raw.trim().length === 0) {
    throw new Error('SKILL.md is empty')
  }

  const { data: frontmatterRaw, content } = matter(raw)

  try {
    const frontmatter = SkillMdFrontmatterSchema.parse(frontmatterRaw)
    return { frontmatter, content, raw }
  } catch (error) {
    if (error instanceof z.ZodError) {
      const issues = error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')
      throw new Error(`SKILL.md frontmatter validation failed: ${issues}`)
    }
    throw error
  }
}

// ═══════════════════════════════════════════════════════════════
// 目录结构校验
// ═══════════════════════════════════════════════════════════════

/**
 * 推断入口文件
 */
async function inferEntryFile(packagePath: string): Promise<string | undefined> {
  const scriptsDir = path.join(packagePath, 'scripts')
  if (!(await fs.pathExists(scriptsDir))) {
    return undefined
  }

  const candidates = ['main.py', 'main.js', 'main.ts', 'index.py', 'index.js', 'index.ts', 'run.py', 'run.js']

  for (const candidate of candidates) {
    const filePath = path.join(scriptsDir, candidate)
    if (await fs.pathExists(filePath)) {
      return `scripts/${candidate}`
    }
  }

  return undefined
}

/**
 * 计算目录大小和文件数
 */
async function calculateDirectoryStats(dirPath: string): Promise<{ fileCount: number; totalSizeBytes: number }> {
  let fileCount = 0
  let totalSizeBytes = 0

  async function traverse(currentPath: string) {
    const stats = await fs.stat(currentPath)

    if (stats.isFile()) {
      fileCount++
      totalSizeBytes += stats.size
    } else if (stats.isDirectory()) {
      const entries = await fs.readdir(currentPath)
      for (const entry of entries) {
        await traverse(path.join(currentPath, entry))
      }
    }
  }

  await traverse(dirPath)
  return { fileCount, totalSizeBytes }
}

/**
 * 校验 Skill 包目录结构（SKILL.md 必需，manifest.json 被拒绝）
 */
export async function validatePackageStructure(packagePath: string): Promise<ValidationResult> {
  const errors: string[] = []
  const warnings: string[] = []
  const details = {
    hasSkillMd: false,
    hasScripts: false,
    hasReferences: false,
    hasAssets: false,
    entryFile: undefined as string | undefined,
    fileCount: 0,
    totalSizeBytes: 0,
  }

  // 检查包路径是否存在
  if (!(await fs.pathExists(packagePath))) {
    errors.push(`Package path does not exist: ${packagePath}`)
    return { valid: false, errors, warnings, details }
  }

  // 1. 检查 SKILL.md（必需）
  const skillMdPath = path.join(packagePath, 'SKILL.md')
  if (await fs.pathExists(skillMdPath)) {
    details.hasSkillMd = true

    // 校验 SKILL.md 内容
    try {
      await parseSkillMd(skillMdPath)
    } catch (error) {
      errors.push(`Invalid SKILL.md: ${error instanceof Error ? error.message : String(error)}`)
    }
  } else {
    errors.push('Missing required file: SKILL.md')
  }

  // 2. 拒绝 manifest.json（不再支持）
  const manifestPath = path.join(packagePath, 'manifest.json')
  if (await fs.pathExists(manifestPath)) {
    warnings.push('manifest.json is deprecated and will be ignored. Use SKILL.md frontmatter instead.')
  }

  // 3. 检查 scripts/ 目录（可选）
  const scriptsDir = path.join(packagePath, 'scripts')
  if (await fs.pathExists(scriptsDir)) {
    details.hasScripts = true
    details.entryFile = await inferEntryFile(packagePath)
    if (!details.entryFile) {
      warnings.push('No entry file found in scripts/ directory')
    }
  }

  // 4. 检查 references/ 目录（可选）
  const referencesDir = path.join(packagePath, 'references')
  if (await fs.pathExists(referencesDir)) {
    details.hasReferences = true
  }

  // 5. 检查 assets/ 目录（可选）
  const assetsDir = path.join(packagePath, 'assets')
  if (await fs.pathExists(assetsDir)) {
    details.hasAssets = true
  }

  // 6. 计算目录统计信息
  const stats = await calculateDirectoryStats(packagePath)
  details.fileCount = stats.fileCount
  details.totalSizeBytes = stats.totalSizeBytes

  // 7. 检查包大小限制（100MB）
  const MAX_PACKAGE_SIZE = 100 * 1024 * 1024
  if (details.totalSizeBytes > MAX_PACKAGE_SIZE) {
    errors.push(`Package size exceeds limit: ${details.totalSizeBytes} bytes (max: ${MAX_PACKAGE_SIZE} bytes)`)
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    details,
  }
}

// ═══════════════════════════════════════════════════════════════
// 校验值计算
// ═══════════════════════════════════════════════════════════════

/**
 * 计算文件 SHA256 校验值
 */
export async function calculateFileSHA256(filePath: string): Promise<string> {
  const hash = createHash('sha256')
  const stream = fs.createReadStream(filePath)

  return new Promise((resolve, reject) => {
    stream.on('data', (chunk: string | Buffer) => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('hex')))
    stream.on('error', reject)
  })
}

/**
 * 计算目录 SHA256 校验值
 */
export async function calculateDirectorySHA256(dirPath: string): Promise<string> {
  const hash = createHash('sha256')
  const files: string[] = []

  async function collectFiles(currentPath: string) {
    const entries = await fs.readdir(currentPath, { withFileTypes: true })

    for (const entry of entries) {
      const fullPath = path.join(currentPath, entry.name)

      if (entry.isFile()) {
        files.push(fullPath)
      } else if (entry.isDirectory()) {
        await collectFiles(fullPath)
      }
    }
  }

  await collectFiles(dirPath)
  files.sort()

  for (const file of files) {
    const relativePath = path.relative(dirPath, file)
    const fileHash = await calculateFileSHA256(file)
    hash.update(`${relativePath}:${fileHash}\n`)
  }

  return hash.digest('hex')
}

// ═══════════════════════════════════════════════════════════════
// 完整校验
// ═══════════════════════════════════════════════════════════════

/**
 * 完整校验 Skill 包（SKILL.md 模式）
 */
export async function validateSkillPackage(packagePath: string): Promise<CompleteValidationResult> {
  const errors: string[] = []
  const warnings: string[] = []
  let skillMd: SkillMdFrontmatter | undefined

  // 1. 校验目录结构
  const structure = await validatePackageStructure(packagePath)
  errors.push(...structure.errors)
  warnings.push(...structure.warnings)

  // 2. 解析 SKILL.md frontmatter
  if (structure.details.hasSkillMd) {
    try {
      const skillMdPath = path.join(packagePath, 'SKILL.md')
      const parsed = await parseSkillMd(skillMdPath)
      skillMd = parsed.frontmatter
    } catch (error) {
      // 错误已在 validatePackageStructure 中记录
    }
  }

  // 3. 计算校验值
  const checksum = await calculateDirectorySHA256(packagePath)

  return {
    valid: errors.length === 0,
    skillMd,
    structure,
    checksum,
    errors,
    warnings,
  }
}

// ═══════════════════════════════════════════════════════════════
// CLI 工具
// ═══════════════════════════════════════════════════════════════

/**
 * 格式化校验结果输出
 */
export function formatValidationResult(result: CompleteValidationResult): string {
  const lines: string[] = []

  lines.push('='.repeat(60))
  lines.push('Skill Package Validation Result (SKILL.md mode)')
  lines.push('='.repeat(60))
  lines.push('')

  lines.push(`Status: ${result.valid ? 'VALID' : 'INVALID'}`)
  lines.push(`Checksum: ${result.checksum}`)
  lines.push('')

  if (result.skillMd) {
    lines.push('SKILL.md Frontmatter:')
    lines.push(`  skill_id: ${result.skillMd.skill_id}`)
    lines.push(`  name: ${result.skillMd.name}`)
    lines.push(`  description: ${result.skillMd.description || 'N/A'}`)
    lines.push('')
  }

  lines.push('Directory Structure:')
  lines.push(`  SKILL.md: ${result.structure.details.hasSkillMd ? 'YES' : 'MISSING'}`)
  lines.push(`  scripts/: ${result.structure.details.hasScripts ? 'YES' : 'N/A'}`)
  lines.push(`  references/: ${result.structure.details.hasReferences ? 'YES' : 'N/A'}`)
  lines.push(`  assets/: ${result.structure.details.hasAssets ? 'YES' : 'N/A'}`)
  if (result.structure.details.entryFile) {
    lines.push(`  entry: ${result.structure.details.entryFile}`)
  }
  lines.push(`  files: ${result.structure.details.fileCount}`)
  lines.push(`  size: ${(result.structure.details.totalSizeBytes / 1024 / 1024).toFixed(2)} MB`)
  lines.push('')

  if (result.errors.length > 0) {
    lines.push('Errors:')
    result.errors.forEach((error) => lines.push(`  - ${error}`))
    lines.push('')
  }

  if (result.warnings.length > 0) {
    lines.push('Warnings:')
    result.warnings.forEach((warning) => lines.push(`  - ${warning}`))
    lines.push('')
  }

  lines.push('='.repeat(60))

  return lines.join('\n')
}

/**
 * CLI 入口
 */
/* eslint-disable no-console -- CLI 入口 */
export async function main() {
  const packagePath = process.argv[2]

  if (!packagePath) {
    console.error('Usage: node validate-skill.js <package-path>')
    process.exit(1)
  }

  try {
    const result = await validateSkillPackage(packagePath)
    console.log(formatValidationResult(result))
    process.exit(result.valid ? 0 : 1)
  } catch (error) {
    console.error('Validation failed:', error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}

// 如果直接运行此脚本 (ES module 兼容)
const isMainModule = import.meta.url === `file://${process.argv[1]}`
if (isMainModule) {
  main()
}
