/**
 * Skills 协议兼容性校验工具
 *
 * 提供 Manifest 校验、目录结构校验、协议兼容性检查等功能
 */

import * as fs from 'fs-extra'
import * as path from 'path'
import { z } from 'zod'
import matter from 'gray-matter'
import { createHash } from 'crypto'

// ═══════════════════════════════════════════════════════════════
// 类型定义
// ═══════════════════════════════════════════════════════════════

/**
 * Skill 工具配置
 */
const SkillToolSchema = z.object({
  name: z.string().min(1).max(100),
  type: z.enum(['function', 'mcp']),
  config: z.record(z.unknown()).optional(),
})

/**
 * Anthropic 兼容配置
 */
const AnthropicCompatSchema = z.object({
  type: z.enum(['anthropic', 'custom']),
  skill_id: z.string().min(1).max(120),
  version: z.string().optional(),
})

/**
 * Container 协议配置
 */
const ContainerSchema = z.object({
  skills: z.array(
    z.object({
      type: z.enum(['anthropic', 'custom']),
      skill_id: z.string().min(1).max(120),
      version: z.string().optional(),
    })
  ),
})

/**
 * Semibot Skill Manifest Schema
 */
export const SemibotSkillManifestSchema = z.object({
  // === 必需字段 ===
  skill_id: z
    .string()
    .min(1)
    .max(120)
    .regex(/^[a-zA-Z0-9._:/-]+$/, 'skill_id must contain only alphanumeric, dots, colons, slashes, hyphens'),
  name: z.string().min(1).max(100),
  version: z
    .string()
    .min(1)
    .max(50)
    .regex(/^\d+\.\d+\.\d+(-[a-zA-Z0-9.]+)?$/, 'version must follow semantic versioning (e.g., 1.0.0, 1.2.3-beta)'),

  // === 推荐字段 ===
  description: z.string().max(1000).optional(),
  trigger_keywords: z.array(z.string().max(50)).max(20).optional(),
  author: z.string().max(100).optional(),
  homepage: z.string().url().optional(),
  documentation: z.string().url().optional(),

  // === 可选字段 ===
  category: z.string().max(50).optional(),
  tags: z.array(z.string().max(30)).max(10).optional(),
  icon_url: z.string().url().optional(),
  license: z.string().max(50).optional(),
  repository: z.string().url().optional(),

  // === 执行配置 ===
  entry: z.string().max(200).optional(),
  tools: z.array(SkillToolSchema).optional(),
  config: z.record(z.unknown()).optional(),

  // === 兼容性 ===
  anthropic: AnthropicCompatSchema.optional(),
  container: ContainerSchema.optional(),
})

export type SemibotSkillManifest = z.infer<typeof SemibotSkillManifestSchema>

/**
 * 目录结构校验结果
 */
export interface ValidationResult {
  valid: boolean
  errors: string[]
  warnings: string[]
  details: {
    hasSkillMd: boolean
    hasManifestJson: boolean
    hasScripts: boolean
    hasReferences: boolean
    hasAssets: boolean
    entryFile?: string
    fileCount: number
    totalSizeBytes: number
  }
}

/**
 * 协议兼容性检查结果
 */
export interface ProtocolCompatibility {
  anthropic: boolean
  codex: boolean
  semibot: boolean
  issues: string[]
}

// ═══════════════════════════════════════════════════════════════
// Manifest 校验
// ═══════════════════════════════════════════════════════════════

/**
 * 校验 Manifest
 *
 * @param manifest - Manifest 对象
 * @returns 校验后的 Manifest
 * @throws 校验失败时抛出错误
 */
export function validateManifest(manifest: unknown): SemibotSkillManifest {
  try {
    return SemibotSkillManifestSchema.parse(manifest)
  } catch (error) {
    if (error instanceof z.ZodError) {
      const issues = error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')
      throw new Error(`Manifest validation failed: ${issues}`)
    }
    throw error
  }
}

/**
 * 校验 Manifest 文件
 *
 * @param manifestPath - Manifest 文件路径
 * @returns 校验后的 Manifest
 */
export async function validateManifestFile(manifestPath: string): Promise<SemibotSkillManifest> {
  if (!(await fs.pathExists(manifestPath))) {
    throw new Error(`Manifest file not found: ${manifestPath}`)
  }

  const manifest = await fs.readJson(manifestPath)
  return validateManifest(manifest)
}

// ═══════════════════════════════════════════════════════════════
// 目录结构校验
// ═══════════════════════════════════════════════════════════════

/**
 * 推断入口文件
 *
 * @param packagePath - 包路径
 * @returns 入口文件相对路径
 */
async function inferEntryFile(packagePath: string): Promise<string | undefined> {
  const scriptsDir = path.join(packagePath, 'scripts')
  if (!(await fs.pathExists(scriptsDir))) {
    return undefined
  }

  // 按优先级查找入口文件
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
 * 校验 Skill 包目录结构
 *
 * @param packagePath - 包路径
 * @returns 校验结果
 */
export async function validatePackageStructure(packagePath: string): Promise<ValidationResult> {
  const errors: string[] = []
  const warnings: string[] = []
  const details = {
    hasSkillMd: false,
    hasManifestJson: false,
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
      const content = await fs.readFile(skillMdPath, 'utf-8')
      if (content.trim().length === 0) {
        warnings.push('SKILL.md is empty')
      }

      // 尝试解析 Frontmatter
      const { data: frontmatter } = matter(content)
      if (!frontmatter.skill_id) {
        warnings.push('SKILL.md frontmatter missing skill_id')
      }
      if (!frontmatter.version) {
        warnings.push('SKILL.md frontmatter missing version')
      }
    } catch (error) {
      warnings.push(`Failed to parse SKILL.md: ${error instanceof Error ? error.message : String(error)}`)
    }
  } else {
    errors.push('Missing required file: SKILL.md')
  }

  // 2. 检查 manifest.json（推荐）
  const manifestPath = path.join(packagePath, 'manifest.json')
  if (await fs.pathExists(manifestPath)) {
    details.hasManifestJson = true

    // 校验 manifest 内容
    try {
      const manifest = await fs.readJson(manifestPath)
      validateManifest(manifest)
    } catch (error) {
      errors.push(`Invalid manifest.json: ${error instanceof Error ? error.message : String(error)}`)
    }
  } else {
    warnings.push('Missing recommended file: manifest.json')
  }

  // 3. 检查 scripts/ 目录（可选）
  const scriptsDir = path.join(packagePath, 'scripts')
  if (await fs.pathExists(scriptsDir)) {
    details.hasScripts = true

    // 推断入口文件
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
  const MAX_PACKAGE_SIZE = 100 * 1024 * 1024 // 100MB
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
// 协议兼容性检查
// ═══════════════════════════════════════════════════════════════

/**
 * 检查 Skill 与协议的兼容性
 *
 * @param manifest - Skill Manifest
 * @returns 兼容性检查结果
 */
export function checkProtocolCompatibility(manifest: SemibotSkillManifest): ProtocolCompatibility {
  const issues: string[] = []

  // 检查 Anthropic 兼容性
  const anthropicCompatible = !!(
    manifest.skill_id &&
    manifest.name &&
    manifest.version &&
    (manifest.anthropic || manifest.container)
  )

  if (!anthropicCompatible) {
    issues.push('Missing Anthropic compatibility fields (anthropic or container)')
  }

  // 检查 Codex 兼容性
  const codexCompatible = !!(manifest.skill_id && manifest.name && manifest.version)

  if (!codexCompatible) {
    issues.push('Missing Codex compatibility fields (skill_id, name, version)')
  }

  // 检查 Semibot 兼容性
  const semibotCompatible = !!(manifest.skill_id && manifest.name && manifest.version)

  if (!semibotCompatible) {
    issues.push('Missing Semibot required fields (skill_id, name, version)')
  }

  return {
    anthropic: anthropicCompatible,
    codex: codexCompatible,
    semibot: semibotCompatible,
    issues,
  }
}

// ═════════════���═════════════════════════════════════════════════
// 校验值计算
// ═══════════════════════════════════════════════════════════════

/**
 * 计算文件 SHA256 校验值
 *
 * @param filePath - 文件路径
 * @returns SHA256 校验值（十六进制字符串）
 */
export async function calculateFileSHA256(filePath: string): Promise<string> {
  const hash = createHash('sha256')
  const stream = fs.createReadStream(filePath)

  return new Promise((resolve, reject) => {
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('hex')))
    stream.on('error', reject)
  })
}

/**
 * 计算目录 SHA256 校验值
 *
 * @param dirPath - 目录路径
 * @returns SHA256 校验值（十六进制字符串）
 */
export async function calculateDirectorySHA256(dirPath: string): Promise<string> {
  const hash = createHash('sha256')
  const files: string[] = []

  // 递归收集所有文件
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

  // 按路径排序确保一致性
  files.sort()

  // 计算每个文件的哈希并合并
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
 * 完整校验结果
 */
export interface CompleteValidationResult {
  valid: boolean
  manifest?: SemibotSkillManifest
  structure: ValidationResult
  compatibility: ProtocolCompatibility
  checksum: string
  tools?: any[]
  config?: any
  errors: string[]
  warnings: string[]
}

/**
 * 完整校验 Skill 包
 *
 * @param packagePath - 包路径
 * @returns 完整校验结果
 */
export async function validateSkillPackage(packagePath: string): Promise<CompleteValidationResult> {
  const errors: string[] = []
  const warnings: string[] = []
  let manifest: SemibotSkillManifest | undefined
  let compatibility: ProtocolCompatibility = {
    anthropic: false,
    codex: false,
    semibot: false,
    issues: [],
  }

  // 1. 校验目录结构
  const structure = await validatePackageStructure(packagePath)
  errors.push(...structure.errors)
  warnings.push(...structure.warnings)

  // 2. 校验 Manifest
  if (structure.details.hasManifestJson) {
    try {
      const manifestPath = path.join(packagePath, 'manifest.json')
      manifest = await validateManifestFile(manifestPath)

      // 3. 检查协议兼容性
      compatibility = checkProtocolCompatibility(manifest)
      warnings.push(...compatibility.issues)
    } catch (error) {
      errors.push(`Manifest validation failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  // 4. 计算校验值
  const checksum = await calculateDirectorySHA256(packagePath)

  return {
    valid: errors.length === 0,
    manifest,
    structure,
    compatibility,
    checksum,
    tools: manifest?.tools,
    config: manifest?.config,
    errors,
    warnings,
  }
}

// ═══════════════════════════════════════════════════════════════
// CLI 工具
// ═════════════════���═════════════════════════════════════════════

/**
 * 格式化校验结果输出
 */
export function formatValidationResult(result: CompleteValidationResult): string {
  const lines: string[] = []

  lines.push('='.repeat(60))
  lines.push('Skill Package Validation Result')
  lines.push('='.repeat(60))
  lines.push('')

  // 总体状态
  lines.push(`Status: ${result.valid ? '✅ VALID' : '❌ INVALID'}`)
  lines.push(`Checksum: ${result.checksum}`)
  lines.push('')

  // Manifest 信息
  if (result.manifest) {
    lines.push('Manifest:')
    lines.push(`  skill_id: ${result.manifest.skill_id}`)
    lines.push(`  name: ${result.manifest.name}`)
    lines.push(`  version: ${result.manifest.version}`)
    lines.push(`  description: ${result.manifest.description || 'N/A'}`)
    lines.push('')
  }

  // 目录结构
  lines.push('Directory Structure:')
  lines.push(`  SKILL.md: ${result.structure.details.hasSkillMd ? '✅' : '❌'}`)
  lines.push(`  manifest.json: ${result.structure.details.hasManifestJson ? '✅' : '⚠️'}`)
  lines.push(`  scripts/: ${result.structure.details.hasScripts ? '✅' : '⚠️'}`)
  lines.push(`  references/: ${result.structure.details.hasReferences ? '✅' : '⚠️'}`)
  lines.push(`  assets/: ${result.structure.details.hasAssets ? '✅' : '⚠️'}`)
  if (result.structure.details.entryFile) {
    lines.push(`  entry: ${result.structure.details.entryFile}`)
  }
  lines.push(`  files: ${result.structure.details.fileCount}`)
  lines.push(`  size: ${(result.structure.details.totalSizeBytes / 1024 / 1024).toFixed(2)} MB`)
  lines.push('')

  // 协议兼容性
  lines.push('Protocol Compatibility:')
  lines.push(`  Anthropic: ${result.compatibility.anthropic ? '✅' : '❌'}`)
  lines.push(`  Codex: ${result.compatibility.codex ? '✅' : '❌'}`)
  lines.push(`  Semibot: ${result.compatibility.semibot ? '✅' : '❌'}`)
  lines.push('')

  // 错误
  if (result.errors.length > 0) {
    lines.push('Errors:')
    result.errors.forEach((error) => lines.push(`  ❌ ${error}`))
    lines.push('')
  }

  // 警告
  if (result.warnings.length > 0) {
    lines.push('Warnings:')
    result.warnings.forEach((warning) => lines.push(`  ⚠️  ${warning}`))
    lines.push('')
  }

  lines.push('='.repeat(60))

  return lines.join('\n')
}

/**
 * CLI 入口
 */
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

// 如果直接运行此脚本
if (require.main === module) {
  main()
}
