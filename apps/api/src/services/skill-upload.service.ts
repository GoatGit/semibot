/**
 * Skill Upload Service
 *
 * 处理技能包文件上传安装：解压 -> 找到包根目录 -> 复用现有 local 安装流程
 */

import * as path from 'path'
import * as crypto from 'crypto'
import fs from 'fs-extra'
import { readdir, stat } from 'fs/promises'
import { extractArchive, findPackageRoot } from '../utils/archive-extractor'
import { parseSkillMd } from '../utils/skill-validator'
import { installSkillPackage } from './skill-install.service'
import { installWithRetry } from './skill-retry-rollback.service'
import * as skillDefinitionRepo from '../repositories/skill-definition.repository'
import { SKILL_UPLOAD_TEMP_DIR, SKILL_MAX_SIZE_BYTES } from '../constants/config'
import { createError } from '../middleware/errorHandler'
import { SKILL_UPLOAD_EXTRACT_FAILED } from '../constants/errorCodes'
import { createLogger } from '../lib/logger'

const uploadServiceLogger = createLogger('skill-upload')

// ═══════════════════════════════════════════════════════════════
// 类型定义
// ═══════════════════════════════════════════════════════════════

export interface UploadAndInstallInput {
  skillDefinitionId: string
  tempFilePath: string
  originalName: string
  enableRetry?: boolean
}

export interface UploadCreateAndInstallInput {
  tempFilePath: string
  originalName: string
  enableRetry?: boolean
  createdBy?: string
}

export interface UploadCreateAndInstallResult {
  definitionId: string
  packageId: string
  created: boolean // true = 新建 definition, false = 更新已有
}

// ═══════════════════════════════════════════════════════════════
// 辅助函数
// ═══════════════════════════════════════════════════════════════

/**
 * 递归计算目录总大小
 */
async function getDirectorySize(dirPath: string): Promise<number> {
  let totalSize = 0
  const entries = await readdir(dirPath, { withFileTypes: true })

  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name)
    if (entry.isDirectory()) {
      totalSize += await getDirectorySize(fullPath)
    } else {
      const fileStat = await stat(fullPath)
      totalSize += fileStat.size
    }
  }

  return totalSize
}

// ═══════════════════════════════════════════════════════════════
// 核心方法
// ═══════════════════════════════════════════════════════════════

/**
 * 上传并安装技能包
 *
 * 1. 生成唯一临时解压目录
 * 2. 解压压缩包
 * 3. 找到包根目录
 * 4. 检查解压后大小
 * 5. 调用现有安装流程
 * 6. 清理临时文件
 */
export async function uploadAndInstall(input: UploadAndInstallInput): Promise<string> {
  const { skillDefinitionId, tempFilePath, originalName, enableRetry } = input

  // 生成唯一临时解压目录
  const extractId = crypto.randomBytes(16).toString('hex')
  const extractDir = path.join(SKILL_UPLOAD_TEMP_DIR, `extract-${extractId}`)

  try {
    // Step 1: 解压
    uploadServiceLogger.info('开始解压技能包', {
      originalName,
      extractDir,
      skillDefinitionId,
    })

    await extractArchive(tempFilePath, extractDir)

    // Step 2: 找到包根目录
    const packageRoot = await findPackageRoot(extractDir)
    uploadServiceLogger.info('检测到包根目录', { packageRoot })

    // Step 3: 检查解压后大��
    const extractedSize = await getDirectorySize(packageRoot)
    if (extractedSize > SKILL_MAX_SIZE_BYTES) {
      uploadServiceLogger.warn('解压后大小超过限制', {
        extractedSize,
        limit: SKILL_MAX_SIZE_BYTES,
        originalName,
      })
      throw createError(SKILL_UPLOAD_EXTRACT_FAILED, `解压后大小 (${Math.round(extractedSize / 1024 / 1024)}MB) 超过限制 (${Math.round(SKILL_MAX_SIZE_BYTES / 1024 / 1024)}MB)`)
    }

    // Step 4: 调用现有安装流程
    const installInput = {
      skillDefinitionId,
      sourceType: 'upload' as const,
      localPath: packageRoot,
    }

    let packageId: string
    if (enableRetry) {
      packageId = await installWithRetry(installInput)
    } else {
      packageId = await installSkillPackage(installInput)
    }

    uploadServiceLogger.info('技能包上传安装成功', {
      skillDefinitionId,
      packageId,
    })

    return packageId
  } catch (error) {
    uploadServiceLogger.error('技能包上传安装失败', error as Error, {
      skillDefinitionId,
      originalName,
    })
    throw error
  } finally {
    // 清理临时解压目录
    try {
      if (await fs.pathExists(extractDir)) {
        await fs.remove(extractDir)
      }
    } catch (cleanupErr) {
      uploadServiceLogger.warn('清理临时解压目录失败', {
        extractDir,
        error: (cleanupErr as Error).message,
      })
    }

    // 清理原始压缩文件
    try {
      if (await fs.pathExists(tempFilePath)) {
        await fs.remove(tempFilePath)
      }
    } catch (cleanupErr) {
      uploadServiceLogger.warn('清理临时压缩文件失败', {
        tempFilePath,
        error: (cleanupErr as Error).message,
      })
    }
  }
}

/**
 * 上传创建并安装技能包（一步到位）
 *
 * 1. 解压压缩包
 * 2. 找到包根目录
 * 3. 解析 SKILL.md frontmatter
 * 4. 自动创建或更新 skill definition
 * 5. 调用现有安装流程
 * 6. 清理临时文件
 */
export async function uploadCreateAndInstall(
  input: UploadCreateAndInstallInput
): Promise<UploadCreateAndInstallResult> {
  const { tempFilePath, originalName, enableRetry, createdBy } = input

  const extractId = crypto.randomBytes(16).toString('hex')
  const extractDir = path.join(SKILL_UPLOAD_TEMP_DIR, `extract-${extractId}`)

  try {
    // Step 1: 解压
    uploadServiceLogger.info('开始解压技能包（upload-create）', {
      originalName,
      extractDir,
    })

    await extractArchive(tempFilePath, extractDir)

    // Step 2: 找到包根目录
    const packageRoot = await findPackageRoot(extractDir)
    uploadServiceLogger.info('检测到包根目录', { packageRoot })

    // Step 3: 检查解压后大小
    const extractedSize = await getDirectorySize(packageRoot)
    if (extractedSize > SKILL_MAX_SIZE_BYTES) {
      uploadServiceLogger.warn('解压后大小超过限制', {
        extractedSize,
        limit: SKILL_MAX_SIZE_BYTES,
        originalName,
      })
      throw createError(
        SKILL_UPLOAD_EXTRACT_FAILED,
        `解压后大小 (${Math.round(extractedSize / 1024 / 1024)}MB) 超过限制 (${Math.round(SKILL_MAX_SIZE_BYTES / 1024 / 1024)}MB)`
      )
    }

    // Step 4: 解析 SKILL.md frontmatter
    const skillMdPath = path.join(packageRoot, 'SKILL.md')
    let parsed
    try {
      parsed = await parseSkillMd(skillMdPath)
    } catch (error) {
      throw createError(
        SKILL_UPLOAD_EXTRACT_FAILED,
        `SKILL.md 解析失败: ${(error as Error).message}`
      )
    }

    const { frontmatter } = parsed

    // 如果 SKILL.md 没有 skill_id，基于 name 自动生成
    const skillId = frontmatter.skill_id
      || frontmatter.name
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-|-$/g, '')

    // Step 5: 查找或创建 definition
    let created = false
    let existing = await skillDefinitionRepo.findBySkillId(skillId)

    if (existing) {
      // 更新已有 definition 的元数据
      uploadServiceLogger.info('更新已有 skill definition', {
        definitionId: existing.id,
        skillId,
      })
      await skillDefinitionRepo.update(existing.id, {
        name: frontmatter.name,
        description: frontmatter.description,
        triggerKeywords: frontmatter.trigger_keywords,
      })
    } else {
      // 创建新 definition
      uploadServiceLogger.info('创建新 skill definition', {
        skillId,
      })
      existing = await skillDefinitionRepo.create({
        skillId,
        name: frontmatter.name,
        description: frontmatter.description,
        triggerKeywords: frontmatter.trigger_keywords,
        createdBy,
      })
      created = true
    }

    const definitionId = existing.id

    // Step 6: 调用现有安装流程
    const installInput = {
      skillDefinitionId: definitionId,
      sourceType: 'upload' as const,
      localPath: packageRoot,
    }

    let packageId: string
    if (enableRetry) {
      packageId = await installWithRetry(installInput)
    } else {
      packageId = await installSkillPackage(installInput)
    }

    uploadServiceLogger.info('技能包 upload-create 安装成功', {
      definitionId,
      packageId,
      created,
    })

    return { definitionId, packageId, created }
  } catch (error) {
    uploadServiceLogger.error('技能包 upload-create 失败', error as Error, {
      originalName,
    })
    throw error
  } finally {
    // 清理临时解压目录
    try {
      if (await fs.pathExists(extractDir)) {
        await fs.remove(extractDir)
      }
    } catch (cleanupErr) {
      uploadServiceLogger.warn('清理临时解压目录失败', {
        extractDir,
        error: (cleanupErr as Error).message,
      })
    }

    // 清理原始压缩文件
    try {
      if (await fs.pathExists(tempFilePath)) {
        await fs.remove(tempFilePath)
      }
    } catch (cleanupErr) {
      uploadServiceLogger.warn('清理临时压缩文件失败', {
        tempFilePath,
        error: (cleanupErr as Error).message,
      })
    }
  }
}
