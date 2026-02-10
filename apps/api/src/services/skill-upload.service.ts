/**
 * Skill Upload Service
 *
 * 处理技能包文件上传安装：解压 -> 找到包根目录 -> 复用现有 local 安装流程
 */

import * as path from 'path'
import * as crypto from 'crypto'
import * as fs from 'fs-extra'
import { extractArchive, findPackageRoot } from '../utils/archive-extractor'
import { installSkillPackage } from './skill-install.service'
import { installWithRetry } from './skill-retry-rollback.service'
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
  version: string
  tempFilePath: string
  originalName: string
  enableRetry?: boolean
}

// ═══════════════════════════════════════════════════════════════
// 辅助函数
// ═══════════════════════════════════════════════════════════════

/**
 * 递归计算目录总大小
 */
async function getDirectorySize(dirPath: string): Promise<number> {
  let totalSize = 0
  const entries = await fs.readdir(dirPath, { withFileTypes: true })

  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name)
    if (entry.isDirectory()) {
      totalSize += await getDirectorySize(fullPath)
    } else {
      const stat = await fs.stat(fullPath)
      totalSize += stat.size
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
  const { skillDefinitionId, version, tempFilePath, originalName, enableRetry } = input

  // 生成唯一临时解压目录
  const extractId = crypto.randomBytes(16).toString('hex')
  const extractDir = path.join(SKILL_UPLOAD_TEMP_DIR, `extract-${extractId}`)

  try {
    // Step 1: 解压
    uploadServiceLogger.info('开始解压技能包', {
      originalName,
      extractDir,
      skillDefinitionId,
      version,
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
      version,
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
      version,
      packageId,
    })

    return packageId
  } catch (error) {
    uploadServiceLogger.error('技能包上传安装失败', error as Error, {
      skillDefinitionId,
      version,
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
