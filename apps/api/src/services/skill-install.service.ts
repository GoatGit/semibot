/**
 * Skill Install Service
 *
 * 处理技能包的安装、验证和状态管理
 * 每次安装覆盖旧包，不做版本管理
 */

import * as path from 'path'
import fs from 'fs-extra'
import { createError } from '../middleware/errorHandler'
import { SKILL_STORAGE_PATH } from '../constants/config'
import * as skillDefinitionRepo from '../repositories/skill-definition.repository'
import * as skillPackageRepo from '../repositories/skill-package.repository'
import * as skillInstallLogRepo from '../repositories/skill-install-log.repository'
import { validateSkillPackage, calculateDirectorySHA256 } from '../utils/skill-validator'
import { createLogger } from '../lib/logger'

const skillInstallLogger = createLogger('skill-install')

// ═══════════════════════════════════════════════════════════════
// 类型定义
// ═══════════════════════════════════════════════════════════════

export interface InstallSkillPackageInput {
  skillDefinitionId: string
  sourceType: 'anthropic' | 'codex' | 'local' | 'upload'
  sourceUrl?: string
  localPath?: string
}

// ═══════════════════════════════════════════════════════════════
// 核心安装流程
// ═══════════════════════════════════════════════════════════════

/**
 * 安装技能包（覆盖式，无版本控制）
 */
export async function installSkillPackage(
  input: InstallSkillPackageInput
): Promise<string> {
  const { skillDefinitionId, sourceType, sourceUrl, localPath } = input

  // Step 1: 验证技能定义存在
  const definition = await skillDefinitionRepo.findById(skillDefinitionId)
  if (!definition) {
    throw createError('SKILL_NOT_FOUND', '技能定义不存在')
  }

  // Step 2: 检查是否有旧包，清理旧文件
  const existingPackage = await skillPackageRepo.findByDefinition(skillDefinitionId)
  if (existingPackage && existingPackage.packagePath) {
    try {
      if (await fs.pathExists(existingPackage.packagePath)) {
        skillInstallLogger.info('清理旧版本文件', {
          skillDefinitionId,
          oldPath: existingPackage.packagePath,
        })
        await fs.remove(existingPackage.packagePath)
      }
    } catch (cleanupError) {
      skillInstallLogger.warn('清理旧版本文件失败', {
        error: (cleanupError as Error).message,
      })
    }
  }

  // Step 3: 创建安装日志
  const log = await skillInstallLogRepo.create({
    skillDefinitionId,
    operation: 'install',
    status: 'pending',
    startedAt: new Date(),
  })

  try {
    // Step 4: 创建/覆盖包记录（upsert）
    const packagePath = path.join(SKILL_STORAGE_PATH, definition.skillId, 'current')
    const pkg = await skillPackageRepo.create({
      skillDefinitionId,
      sourceType,
      sourceUrl,
      packagePath,
      checksumSha256: 'pending',
      status: 'pending',
    })

    // 更新日志
    await skillInstallLogRepo.update(log.id, {
      skillPackageId: pkg.id,
      status: 'in_progress',
    })

    // Step 5: 下载/复制包文件
    await skillPackageRepo.update(pkg.id, { status: 'downloading' })

    if ((sourceType === 'local' || sourceType === 'upload') && localPath) {
      await fs.ensureDir(packagePath)
      await fs.copy(localPath, packagePath)
    } else if (sourceType === 'anthropic' && sourceUrl) {
      await fs.ensureDir(packagePath)
      throw createError('NOT_IMPLEMENTED', 'Anthropic 下载功能尚未实现')
    } else if (sourceType === 'codex' && sourceUrl) {
      await fs.ensureDir(packagePath)
      throw createError('NOT_IMPLEMENTED', 'Codex 下载功能尚未实现')
    } else {
      throw createError('INVALID_SOURCE', '无效的安装来源')
    }

    // Step 6: 验证包结构
    await skillPackageRepo.update(pkg.id, { status: 'validating' })

    const validationResult = await validateSkillPackage(packagePath)
    if (!validationResult.valid) {
      throw createError('VALIDATION_FAILED', `验证失败: ${validationResult.errors.join(', ')}`)
    }

    // Step 7: 计算校验值
    const checksumSha256 = await calculateDirectorySHA256(packagePath)

    const stats = await fs.stat(packagePath)
    const packageSizeBytes = stats.size

    // Step 8: 更新为 active 状态
    await skillPackageRepo.update(pkg.id, {
      status: 'installing',
    })

    await skillPackageRepo.update(pkg.id, {
      status: 'active',
      checksumSha256,
      packageSizeBytes,
      validationResult: validationResult.skillMd || {},
      installedAt: new Date(),
    })

    // 更新日志为成功
    await skillInstallLogRepo.update(log.id, {
      status: 'success',
      completedAt: new Date(),
    })

    return pkg.id
  } catch (error: any) {
    // 安装失败，更新状态
    await skillInstallLogRepo.update(log.id, {
      status: 'failed',
      errorMessage: error.message,
      completedAt: new Date(),
    })

    // 清理失败的包
    try {
      const pkg = await skillPackageRepo.findByDefinition(skillDefinitionId)
      if (pkg) {
        await skillPackageRepo.update(pkg.id, { status: 'failed' })

        if (await fs.pathExists(pkg.packagePath)) {
          await fs.remove(pkg.packagePath)
        }
      }
    } catch (cleanupError) {
      skillInstallLogger.error('清理失败的包时出错', cleanupError as Error)
    }

    throw error
  }
}

/**
 * 获取安装状态
 */
export async function getInstallStatus(skillDefinitionId: string) {
  const pkg = await skillPackageRepo.findByDefinition(skillDefinitionId)
  if (!pkg) {
    return { status: 'not_found' }
  }

  const logs = await skillInstallLogRepo.findByPackage(pkg.id)
  const latestLog = logs[0]

  return {
    status: pkg.status,
    package: pkg,
    latestLog,
    logs,
  }
}

/**
 * 取消安装
 */
export async function cancelInstall(skillDefinitionId: string): Promise<void> {
  const pkg = await skillPackageRepo.findByDefinition(skillDefinitionId)
  if (!pkg) {
    throw createError('PACKAGE_NOT_FOUND', '技能包不存在')
  }

  if (pkg.status === 'active') {
    throw createError('CANNOT_CANCEL', '已安装的包无法取消')
  }

  await skillPackageRepo.update(pkg.id, { status: 'failed' })

  const logs = await skillInstallLogRepo.findByPackage(pkg.id)
  if (logs.length > 0) {
    await skillInstallLogRepo.update(logs[0].id, {
      status: 'failed',
      errorMessage: '用户取消安装',
      completedAt: new Date(),
    })
  }

  if (await fs.pathExists(pkg.packagePath)) {
    await fs.remove(pkg.packagePath)
  }
}

/**
 * 卸载技能包
 */
export async function uninstallSkillPackage(
  skillDefinitionId: string
): Promise<void> {
  const pkg = await skillPackageRepo.findByDefinition(skillDefinitionId)
  if (!pkg) {
    throw createError('PACKAGE_NOT_FOUND', '技能包不存在')
  }

  const definition = await skillDefinitionRepo.findById(skillDefinitionId)
  if (!definition) {
    throw createError('SKILL_NOT_FOUND', '技能定义不存在')
  }

  const log = await skillInstallLogRepo.create({
    skillDefinitionId,
    skillPackageId: pkg.id,
    operation: 'install',
    status: 'in_progress',
    startedAt: new Date(),
  })

  try {
    // 删除包记录
    await skillPackageRepo.remove(pkg.id)

    // 删除文件
    if (await fs.pathExists(pkg.packagePath)) {
      await fs.remove(pkg.packagePath)
    }

    await skillInstallLogRepo.update(log.id, {
      status: 'success',
      completedAt: new Date(),
    })
  } catch (error: any) {
    await skillInstallLogRepo.update(log.id, {
      status: 'failed',
      errorMessage: error.message,
      completedAt: new Date(),
    })

    throw error
  }
}

/**
 * 获取技能包信息
 */
export async function getSkillPackageInfo(skillDefinitionId: string) {
  const pkg = await skillPackageRepo.findByDefinition(skillDefinitionId)
  if (!pkg) {
    throw createError('PACKAGE_NOT_FOUND', '技能包不存在')
  }

  const definition = await skillDefinitionRepo.findById(skillDefinitionId)
  const logs = await skillInstallLogRepo.findByPackage(pkg.id)

  return {
    package: pkg,
    definition,
    logs,
  }
}

/**
 * 从 Anthropic Skill ID 安装
 */
export async function installFromAnthropicSkillId(
  skillId: string
): Promise<string> {
  let definition = await skillDefinitionRepo.findBySkillId(skillId)

  if (!definition) {
    definition = await skillDefinitionRepo.create({
      skillId,
      name: skillId,
      protocol: 'anthropic',
      sourceType: 'anthropic',
      sourceUrl: `https://api.anthropic.com/v1/skills/${skillId}`,
      status: 'active',
    })
  }

  return installSkillPackage({
    skillDefinitionId: definition.id,
    sourceType: 'anthropic',
    sourceUrl: `https://api.anthropic.com/v1/skills/${skillId}`,
  })
}

/**
 * 从 Manifest URL 安装
 */
export async function installFromManifestUrl(
  manifestUrl: string,
  skillId?: string
): Promise<string> {
  const parsedSkillId = skillId || manifestUrl.split('/').pop() || 'unknown'

  let definition = await skillDefinitionRepo.findBySkillId(parsedSkillId)

  if (!definition) {
    definition = await skillDefinitionRepo.create({
      skillId: parsedSkillId,
      name: parsedSkillId,
      protocol: 'codex',
      sourceType: 'url',
      sourceUrl: manifestUrl,
      status: 'active',
    })
  }

  return installSkillPackage({
    skillDefinitionId: definition.id,
    sourceType: 'codex',
    sourceUrl: manifestUrl,
  })
}
