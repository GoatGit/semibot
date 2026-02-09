/**
 * Skill Retry and Rollback Service
 *
 * 处理技能包的重试和回滚逻辑
 */

import * as fs from 'fs-extra'
import { createError } from '../middleware/errorHandler'
import * as skillDefinitionRepo from '../repositories/skill-definition.repository'
import * as skillPackageRepo from '../repositories/skill-package.repository'
import * as skillInstallLogRepo from '../repositories/skill-install-log.repository'
import * as skillInstallService from './skill-install.service'

// ═══════════════════════════════════════════════════════════════
// 类型定义
// ═══════════════════════════════════════════════════════════════

export interface RetryOptions {
  maxRetries?: number
  retryDelay?: number
}

export interface VersionHistoryItem {
  version: string
  status: string
  installedAt?: string
  isCurrent: boolean
}

// ═══════════════════════════════════════════════════════════════
// 配置
// ═══════════════════════════════════════════════════════════════

const DEFAULT_MAX_RETRIES = 3
const DEFAULT_RETRY_DELAY = 1000 // 1 秒

// ═══════════════════════════════════════════════════════════════
// 重试逻辑
// ═══════════════════════════════════════════════════════════════

/**
 * 判断错误是否可重试
 */
function isRetryableError(error: any): boolean {
  const retryableCodes = [
    'ECONNRESET',
    'ETIMEDOUT',
    'ENOTFOUND',
    'ENETUNREACH',
    'EAI_AGAIN',
  ]

  return retryableCodes.includes(error.code) || error.message?.includes('network')
}

/**
 * 计算指数退避延迟
 */
function calculateBackoffDelay(attempt: number, baseDelay: number): number {
  return baseDelay * Math.pow(2, attempt - 1)
}

/**
 * 带重试的安装
 */
export async function installWithRetry(
  input: skillInstallService.InstallSkillPackageInput,
  maxRetries: number = DEFAULT_MAX_RETRIES
): Promise<string> {
  let lastError: any

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await skillInstallService.installSkillPackage(input)
    } catch (error: any) {
      lastError = error

      // 如果不是可重试错误，直接抛出
      if (!isRetryableError(error)) {
        throw error
      }

      // 如果已达到最大重试次数，抛出错误
      if (attempt >= maxRetries) {
        throw createError(
          'INSTALL_FAILED_AFTER_RETRIES',
          `安装失败，已重试 ${maxRetries} 次: ${error.message}`
        )
      }

      // 计算延迟并等待
      const delay = calculateBackoffDelay(attempt, DEFAULT_RETRY_DELAY)
      await new Promise((resolve) => setTimeout(resolve, delay))
    }
  }

  throw lastError
}

// ═══════════════════════════════════════════════════════════════
// 回滚逻辑
// ═══════════════════════════════════════════════════════════════

/**
 * 回滚到指定版本
 */
export async function rollbackToVersion(
  skillDefinitionId: string,
  targetVersion: string,
  reason?: string
): Promise<string> {
  // 验证技能定义存在
  const definition = await skillDefinitionRepo.findById(skillDefinitionId)
  if (!definition) {
    throw createError('SKILL_NOT_FOUND', '技能定义不存在')
  }

  // 验证目标版本存在
  const targetPackage = await skillPackageRepo.findByDefinitionAndVersion(
    skillDefinitionId,
    targetVersion
  )
  if (!targetPackage) {
    throw createError('VERSION_NOT_FOUND', '目标版本不存在')
  }

  // 验证目标版本状态
  if (targetPackage.status !== 'active') {
    throw createError('INVALID_VERSION_STATUS', '目标版本状态无效，无法回滚')
  }

  // 验证包文件存在
  if (!(await fs.pathExists(targetPackage.packagePath))) {
    throw createError('PACKAGE_FILE_NOT_FOUND', '目标版本的包文件不存在')
  }

  // 创建回滚日志
  const log = await skillInstallLogRepo.create({
    skillDefinitionId,
    skillPackageId: targetPackage.id,
    version: targetVersion,
    operation: 'rollback',
    status: 'in_progress',
    startedAt: new Date(),
    message: reason || `回滚到版本 ${targetVersion}`,
  })

  try {
    // 如果有当前版本，将其标记为 deprecated
    if (definition.currentVersion && definition.currentVersion !== targetVersion) {
      const currentPackage = await skillPackageRepo.findByDefinitionAndVersion(
        skillDefinitionId,
        definition.currentVersion
      )
      if (currentPackage) {
        await skillPackageRepo.update(currentPackage.id, {
          status: 'deprecated',
        })
      }
    }

    // 更新技能定义的当前版本
    await skillDefinitionRepo.update(skillDefinitionId, {
      currentVersion: targetVersion,
    })

    // 更新日志为成功
    await skillInstallLogRepo.update(log.id, {
      status: 'success',
      errorMessage: reason,
      completedAt: new Date(),
    })

    return targetPackage.id
  } catch (error: any) {
    // 回滚失败
    await skillInstallLogRepo.update(log.id, {
      status: 'failed',
      errorMessage: error.message,
      completedAt: new Date(),
    })

    throw error
  }
}

/**
 * 回滚到上一个版本
 */
export async function rollbackToPreviousVersion(
  skillDefinitionId: string
): Promise<string> {
  const definition = await skillDefinitionRepo.findById(skillDefinitionId)
  if (!definition) {
    throw createError('SKILL_NOT_FOUND', '技能定义不存在')
  }

  if (!definition.currentVersion) {
    throw createError('NO_CURRENT_VERSION', '当前没有激活的版本')
  }

  // 获取所有 active 版本，按时间排序
  const packages = await skillPackageRepo.findActiveByDefinition(skillDefinitionId)

  // 过滤掉当前版本
  const previousPackages = packages.filter((pkg) => pkg.version !== definition.currentVersion)

  if (previousPackages.length === 0) {
    throw createError('NO_PREVIOUS_VERSION', '没有可回滚的历史版本')
  }

  // 获取最新的历史版本
  const previousPackage = previousPackages[0]

  return rollbackToVersion(skillDefinitionId, previousPackage.version, '回滚到上一版本')
}

// ═══════════════════════════════════════════════════════════════
// 版本历史
// ═══════════════════════════════════════════════════════════════

/**
 * 获取版本历史
 */
export async function getVersionHistory(skillDefinitionId: string): Promise<VersionHistoryItem[]> {
  const definition = await skillDefinitionRepo.findById(skillDefinitionId)
  if (!definition) {
    throw createError('SKILL_NOT_FOUND', '技能定义不存在')
  }

  const packages = await skillPackageRepo.findAllByDefinition(skillDefinitionId)

  return packages.map((pkg) => ({
    version: pkg.version,
    status: pkg.status,
    installedAt: pkg.installedAt,
    isCurrent: pkg.version === definition.currentVersion,
  }))
}

/**
 * 检查是否可以回滚到指定版本
 */
export async function canRollbackToVersion(
  skillDefinitionId: string,
  targetVersion: string
): Promise<{ canRollback: boolean; reason?: string }> {
  const targetPackage = await skillPackageRepo.findByDefinitionAndVersion(
    skillDefinitionId,
    targetVersion
  )

  if (!targetPackage) {
    return { canRollback: false, reason: '目标版本不存在' }
  }

  if (targetPackage.status !== 'active') {
    return { canRollback: false, reason: '目标版本状态无效' }
  }

  if (!(await fs.pathExists(targetPackage.packagePath))) {
    return { canRollback: false, reason: '目标版本的包文件不存在' }
  }

  return { canRollback: true }
}

// ═══════════════════════════════════════════════════════════════
// 清理逻辑
// ═══════════════════════════════════════════════════════════════

/**
 * 清理失败的安装
 */
export async function cleanupFailedInstall(
  skillDefinitionId: string,
  version: string
): Promise<void> {
  const pkg = await skillPackageRepo.findByDefinitionAndVersion(skillDefinitionId, version)

  if (!pkg) {
    return // 包不存在，无需清理
  }

  if (pkg.status !== 'failed') {
    return // 只清理失败的包
  }

  // 删除文件
  if (await fs.pathExists(pkg.packagePath)) {
    await fs.remove(pkg.packagePath)
  }

  // 删除包记录
  await skillPackageRepo.remove(pkg.id)
}

/**
 * 清理所有失败的安装
 */
export async function cleanupAllFailedInstalls(skillDefinitionId: string): Promise<number> {
  const packages = await skillPackageRepo.findAllByDefinition(skillDefinitionId)
  const failedPackages = packages.filter((pkg) => pkg.status === 'failed')

  let cleanedCount = 0

  for (const pkg of failedPackages) {
    try {
      await cleanupFailedInstall(skillDefinitionId, pkg.version)
      cleanedCount++
    } catch (error) {
      console.error(`清理失败的包 ${pkg.version} 时出错:`, error)
    }
  }

  return cleanedCount
}

/**
 * 清理旧版本（保留最近 N 个版本）
 */
export async function cleanupOldVersions(
  skillDefinitionId: string,
  keepCount: number = 5
): Promise<number> {
  const definition = await skillDefinitionRepo.findById(skillDefinitionId)
  if (!definition) {
    throw createError('SKILL_NOT_FOUND', '技能定义不存在')
  }

  const packages = await skillPackageRepo.findAllByDefinition(skillDefinitionId)

  // 按时间排序，保留最新的 N 个版本和当前版本
  const sortedPackages = packages.sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  )

  const packagesToKeep = new Set<string>()

  // 保留当前版本
  if (definition.currentVersion) {
    const currentPkg = packages.find((pkg) => pkg.version === definition.currentVersion)
    if (currentPkg) {
      packagesToKeep.add(currentPkg.id)
    }
  }

  // 保留最新的 N 个版本
  sortedPackages.slice(0, keepCount).forEach((pkg) => {
    packagesToKeep.add(pkg.id)
  })

  // 删除其他版本
  let deletedCount = 0

  for (const pkg of sortedPackages) {
    if (!packagesToKeep.has(pkg.id) && pkg.status !== 'active') {
      try {
        // 删除文件
        if (await fs.pathExists(pkg.packagePath)) {
          await fs.remove(pkg.packagePath)
        }

        // 删除包记录
        await skillPackageRepo.remove(pkg.id)
        deletedCount++
      } catch (error) {
        console.error(`删除旧版本 ${pkg.version} 时出错:`, error)
      }
    }
  }

  return deletedCount
}
