/**
 * Skill Install Service
 *
 * 处理技能包的安装、验证和状态管理
 */

import * as path from 'path'
import * as fs from 'fs-extra'
import { createError } from '../middleware/errorHandler'
import * as skillDefinitionRepo from '../repositories/skill-definition.repository'
import * as skillPackageRepo from '../repositories/skill-package.repository'
import * as skillInstallLogRepo from '../repositories/skill-install-log.repository'
import { validateSkillPackage, calculateDirectorySHA256 } from '../utils/skill-validator'
import { createLogger } from '../lib/logger'

const skillInstallLogger = createLogger('skill-install')

// ════════════════════════════════════════════════════════���══════
// 类型定义
// ═══════════════════════════════════════════════════════════════

export interface InstallSkillPackageInput {
  skillDefinitionId: string
  version: string
  sourceType: 'anthropic' | 'codex' | 'local' | 'upload'
  sourceUrl?: string
  localPath?: string
}

// ═══════════════════════════════════════════════════════════════
// 配置
// ═══════════════════════════════════════════════════��═══════════

const SKILL_STORAGE_PATH = process.env.SKILL_STORAGE_PATH || '/var/lib/semibot/skills'

// ═══════════════════════════════════════════════════════════════
// 核心安装流程
// ═══════════════════════════════════════════════════════════════

/**
 * 安装技能包（8步流程）
 */
export async function installSkillPackage(
  input: InstallSkillPackageInput
): Promise<string> {
  const { skillDefinitionId, version, sourceType, sourceUrl, localPath } = input

  // Step 1: 验证技能定义存在
  const definition = await skillDefinitionRepo.findById(skillDefinitionId)
  if (!definition) {
    throw createError('SKILL_NOT_FOUND', '技能定义不存在')
  }

  // Step 2: 检查版本是否已存在
  const existingPackage = await skillPackageRepo.findByDefinitionAndVersion(skillDefinitionId, version)
  if (existingPackage) {
    throw createError('SKILL_VERSION_EXISTS', '该版本已存在')
  }

  // Step 3: 创建安装日志
  const log = await skillInstallLogRepo.create({
    skillDefinitionId,
    version,
    operation: 'install',
    status: 'pending',
    startedAt: new Date(),
  })

  try {
    // Step 4: 创建包记录（pending 状态）
    const packagePath = path.join(SKILL_STORAGE_PATH, definition.skillId, version)
    const pkg = await skillPackageRepo.create({
      skillDefinitionId,
      version,
      sourceType,
      sourceUrl,
      packagePath,
      checksumSha256: 'pending', // 临时值
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
      // 从本地路径复制
      await fs.ensureDir(packagePath)
      await fs.copy(localPath, packagePath)
    } else if (sourceType === 'anthropic' && sourceUrl) {
      // 从 Anthropic 下载（简化实现）
      await fs.ensureDir(packagePath)
      // TODO: 实现实际的下载逻辑
      throw createError('NOT_IMPLEMENTED', 'Anthropic 下载功能尚未实现')
    } else if (sourceType === 'codex' && sourceUrl) {
      // 从 Codex 下载（简化实现）
      await fs.ensureDir(packagePath)
      // TODO: 实现实际的下载逻辑
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

    // 获取包大小
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
      validationResult: validationResult.manifest || {},
      tools: validationResult.tools || [],
      config: validationResult.config || {},
      installedAt: new Date(),
    })

    // 更新技能定义的当前版本
    await skillDefinitionRepo.update(skillDefinitionId, {
      currentVersion: version,
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
      const pkg = await skillPackageRepo.findByDefinitionAndVersion(skillDefinitionId, version)
      if (pkg) {
        await skillPackageRepo.update(pkg.id, { status: 'failed' })

        // 删除文件
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
export async function getInstallStatus(skillDefinitionId: string, version: string) {
  const pkg = await skillPackageRepo.findByDefinitionAndVersion(skillDefinitionId, version)
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
export async function cancelInstall(skillDefinitionId: string, version: string): Promise<void> {
  const pkg = await skillPackageRepo.findByDefinitionAndVersion(skillDefinitionId, version)
  if (!pkg) {
    throw createError('PACKAGE_NOT_FOUND', '技能包不存在')
  }

  if (pkg.status === 'active') {
    throw createError('CANNOT_CANCEL', '已安装的包无法取消')
  }

  // 更新状态为 failed
  await skillPackageRepo.update(pkg.id, { status: 'failed' })

  // 更新日志
  const logs = await skillInstallLogRepo.findByPackage(pkg.id)
  if (logs.length > 0) {
    await skillInstallLogRepo.update(logs[0].id, {
      status: 'failed',
      errorMessage: '用户取消安装',
      completedAt: new Date(),
    })
  }

  // 清理文件
  if (await fs.pathExists(pkg.packagePath)) {
    await fs.remove(pkg.packagePath)
  }
}

/**
 * 卸载技能包
 */
export async function uninstallSkillPackage(
  skillDefinitionId: string,
  version: string
): Promise<void> {
  const pkg = await skillPackageRepo.findByDefinitionAndVersion(skillDefinitionId, version)
  if (!pkg) {
    throw createError('PACKAGE_NOT_FOUND', '技能包不存在')
  }

  const definition = await skillDefinitionRepo.findById(skillDefinitionId)
  if (!definition) {
    throw createError('SKILL_NOT_FOUND', '技能定义不存在')
  }

  // 创建卸载日志
  const log = await skillInstallLogRepo.create({
    skillDefinitionId,
    skillPackageId: pkg.id,
    version,
    operation: 'install', // 使用 install 操作类型，但状态为 failed
    status: 'in_progress',
    startedAt: new Date(),
  })

  try {
    // 如果是当前版本，清除当前版本
    if (definition.currentVersion === version) {
      await skillDefinitionRepo.update(skillDefinitionId, {
        currentVersion: undefined,
      })
    }

    // 删除包记录
    await skillPackageRepo.remove(pkg.id)

    // 删除文件
    if (await fs.pathExists(pkg.packagePath)) {
      await fs.remove(pkg.packagePath)
    }

    // 更新日志
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
export async function getSkillPackageInfo(skillDefinitionId: string, version: string) {
  const pkg = await skillPackageRepo.findByDefinitionAndVersion(skillDefinitionId, version)
  if (!pkg) {
    throw createError('PACKAGE_NOT_FOUND', '技能包不存在')
  }

  const definition = await skillDefinitionRepo.findById(skillDefinitionId)
  const logs = await skillInstallLogRepo.findByPackage(pkg.id)

  return {
    package: pkg,
    definition,
    logs,
    isCurrent: definition?.currentVersion === version,
  }
}

/**
 * 列出所有技能包
 */
export async function listSkillPackages(skillDefinitionId: string) {
  const packages = await skillPackageRepo.findAllByDefinition(skillDefinitionId)
  const definition = await skillDefinitionRepo.findById(skillDefinitionId)

  return {
    packages,
    currentVersion: definition?.currentVersion,
  }
}

/**
 * 从 Anthropic Skill ID 安装
 */
export async function installFromAnthropicSkillId(
  skillId: string,
  version?: string
): Promise<string> {
  // 查找或创建技能定义
  let definition = await skillDefinitionRepo.findBySkillId(skillId)

  if (!definition) {
    // 创建新的技能定义
    definition = await skillDefinitionRepo.create({
      skillId,
      name: skillId,
      protocol: 'anthropic',
      sourceType: 'anthropic',
      sourceUrl: `https://api.anthropic.com/v1/skills/${skillId}`,
      status: 'active',
    })
  }

  // 安装技能包
  return installSkillPackage({
    skillDefinitionId: definition.id,
    version: version || 'latest',
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
  // 下载并解析 manifest
  // TODO: 实现实际的下载和解析逻辑
  const parsedSkillId = skillId || manifestUrl.split('/').pop() || 'unknown'

  // 查找或创建技能定义
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

  // 安装技能包
  return installSkillPackage({
    skillDefinitionId: definition.id,
    version: 'latest',
    sourceType: 'codex',
    sourceUrl: manifestUrl,
  })
}
