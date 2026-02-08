/**
 * Skill Definitions API 路由（新模型）
 *
 * 提供技能定义和版本管理的 API
 */

import { Router, type Response } from 'express'
import { z } from 'zod'
import { authenticate, requirePermission, type AuthRequest } from '../../middleware/auth'
import { asyncHandler, validate } from '../../middleware/errorHandler'
import { combinedRateLimit } from '../../middleware/rateLimit'
import * as skillDefinitionRepo from '../../repositories/skill-definition.repository'
import * as skillPackageRepo from '../../repositories/skill-package.repository'
import * as skillInstallLogRepo from '../../repositories/skill-install-log.repository'
import {
  installSkillPackage,
  installFromAnthropicSkillId,
  installFromManifestUrl,
} from '../../services/skill-install.service'
import {
  installWithRetry,
  rollbackToVersion,
  rollbackToPreviousVersion,
  getVersionHistory,
  canRollbackToVersion,
} from '../../services/skill-retry-rollback.service'

const router: Router = Router()

// ═══════════════════════════════════════════════════════════════
// Schema 定义
// ═══════════════════════════════════════════════════════════════

const createSkillDefinitionSchema = z.object({
  skillId: z.string().min(1).max(120).regex(/^[a-zA-Z0-9._:/-]+$/),
  name: z.string().min(1).max(100),
  description: z.string().max(1000).optional(),
  protocol: z.enum(['anthropic', 'codex', 'semibot']).optional(),
  sourceType: z.enum(['anthropic', 'codex', 'url', 'local']).optional(),
  sourceUrl: z.string().url().optional(),
})

const updateSkillDefinitionSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(1000).optional(),
  status: z.enum(['active', 'inactive', 'deprecated']).optional(),
})

const installSkillPackageSchema = z.object({
  version: z.string().min(1).max(50),
  sourceType: z.enum(['anthropic', 'codex', 'url', 'local']),
  sourceUrl: z.string().url().optional(),
  localPath: z.string().optional(),
  enableRetry: z.boolean().optional(),
})

const rollbackVersionSchema = z.object({
  targetVersion: z.string().min(1).max(50),
  reason: z.string().max(500).optional(),
})

const installFromAnthropicSchema = z.object({
  skillId: z.string().min(1).max(120).regex(/^[a-zA-Z0-9._:/-]+$/),
  version: z.string().min(1).max(50).optional(),
})

const installFromManifestSchema = z.object({
  manifestUrl: z.string().url(),
  skillId: z.string().min(1).max(120).optional(),
})

// ═══════════════════════════════════════════════════════════════
// Skill Definition CRUD
// ═══════════════════════════════════════════════════════════════

/**
 * POST /api/v1/skill-definitions
 * 创建技能定义（仅管理员）
 */
router.post(
  '/',
  authenticate,
  requirePermission('admin'),
  combinedRateLimit,
  validate(createSkillDefinitionSchema),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const input = req.body

    const definition = await skillDefinitionRepo.create({
      ...input,
      status: 'active',
    })

    res.status(201).json({
      success: true,
      data: definition,
    })
  })
)

/**
 * GET /api/v1/skill-definitions
 * 列出技能定义（所有用户可见）
 */
router.get(
  '/',
  authenticate,
  combinedRateLimit,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const page = parseInt(req.query.page as string) || 1
    const pageSize = parseInt(req.query.pageSize as string) || 20
    const search = req.query.search as string
    const isActive = req.query.isActive === 'true' ? true : req.query.isActive === 'false' ? false : undefined

    const result = await skillDefinitionRepo.findAll({
      page,
      pageSize,
      search,
      isActive,
    })

    res.json({
      success: true,
      data: result.data,
      pagination: {
        total: result.total,
        page: result.page,
        pageSize: result.pageSize,
        totalPages: Math.ceil(result.total / result.pageSize),
      },
    })
  })
)

/**
 * GET /api/v1/skill-definitions/:id
 * 获取技能定义详情
 */
router.get(
  '/:id',
  authenticate,
  combinedRateLimit,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const { id } = req.params

    const definition = await skillDefinitionRepo.findById(id)

    if (!definition) {
      res.status(404).json({
        success: false,
        error: {
          code: 'SKILL_NOT_FOUND',
          message: '技能定义不存在',
        },
      })
      return
    }

    res.json({
      success: true,
      data: definition,
    })
  })
)

/**
 * PUT /api/v1/skill-definitions/:id
 * 更新技能定义（仅管理员）
 */
router.put(
  '/:id',
  authenticate,
  requirePermission('admin'),
  combinedRateLimit,
  validate(updateSkillDefinitionSchema),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const { id } = req.params
    const input = req.body

    const definition = await skillDefinitionRepo.update(id, input)

    if (!definition) {
      res.status(404).json({
        success: false,
        error: {
          code: 'SKILL_NOT_FOUND',
          message: '技能定义不存在',
        },
      })
      return
    }

    res.json({
      success: true,
      data: definition,
    })
  })
)

/**
 * DELETE /api/v1/skill-definitions/:id
 * 删除技能定义（仅管理员）
 */
router.delete(
  '/:id',
  authenticate,
  requirePermission('admin'),
  combinedRateLimit,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const { id } = req.params

    await skillDefinitionRepo.remove(id)

    res.json({
      success: true,
      data: { id },
    })
  })
)

// ═══════════════════════════════════════════════════════════════
// 版本管理 API
// ═══════════════════════════════════════════════════════════════

/**
 * POST /api/v1/skill-definitions/:id/install
 * 安装技能包（仅管理员）
 */
router.post(
  '/:id/install',
  authenticate,
  requirePermission('admin'),
  combinedRateLimit,
  validate(installSkillPackageSchema),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const { id } = req.params
    const input = req.body

    const installInput = {
      skillDefinitionId: id,
      ...input,
    }

    let packageId: string

    if (input.enableRetry) {
      packageId = await installWithRetry(installInput)
    } else {
      packageId = await installSkillPackage(installInput)
    }

    const pkg = await skillPackageRepo.findById(packageId)

    res.status(201).json({
      success: true,
      data: pkg,
    })
  })
)

/**
 * GET /api/v1/skill-definitions/:id/versions
 * 查询可用版本列表
 */
router.get(
  '/:id/versions',
  authenticate,
  combinedRateLimit,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const { id } = req.params

    const versions = await getVersionHistory(id)

    res.json({
      success: true,
      data: versions,
    })
  })
)

/**
 * GET /api/v1/skill-definitions/:id/versions/:version
 * 获取特定版本详情
 */
router.get(
  '/:id/versions/:version',
  authenticate,
  combinedRateLimit,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const { id, version } = req.params

    const pkg = await skillPackageRepo.findByDefinitionAndVersion(id, version)

    if (!pkg) {
      res.status(404).json({
        success: false,
        error: {
          code: 'VERSION_NOT_FOUND',
          message: '版本不存在',
        },
      })
      return
    }

    res.json({
      success: true,
      data: pkg,
    })
  })
)

/**
 * POST /api/v1/skill-definitions/:id/rollback
 * 回滚版本（仅管理员）
 */
router.post(
  '/:id/rollback',
  authenticate,
  requirePermission('admin'),
  combinedRateLimit,
  validate(rollbackVersionSchema),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const { id } = req.params
    const userId = req.user!.userId
    const { targetVersion } = req.body

    // 检查是否可回滚
    const checkResult = await canRollbackToVersion(id, targetVersion)

    if (!checkResult.canRollback) {
      res.status(400).json({
        success: false,
        error: {
          code: 'ROLLBACK_NOT_ALLOWED',
          message: checkResult.reason || '无法回滚到该版本',
        },
      })
      return
    }

    const result = await rollbackToVersion(userId, id, targetVersion)

    res.json({
      success: true,
      data: result,
      message: `已回滚到版本 ${targetVersion}`,
    })
  })
)

/**
 * POST /api/v1/skill-definitions/:id/rollback-previous
 * 回滚到上一个版本（仅管理员）
 */
router.post(
  '/:id/rollback-previous',
  authenticate,
  requirePermission('admin'),
  combinedRateLimit,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const { id } = req.params

    const result = await rollbackToPreviousVersion(id)

    res.json({
      success: true,
      data: result,
      message: `已回滚到上一个版本`,
    })
  })
)

/**
 * GET /api/v1/skill-definitions/:id/install-logs
 * 查询安装日志
 */
router.get(
  '/:id/install-logs',
  authenticate,
  combinedRateLimit,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const { id } = req.params

    const logs = await skillInstallLogRepo.findByDefinition(id)

    res.json({
      success: true,
      data: logs,
    })
  })
)

// ═══════════════════════════════════════════════════════════════
// 快捷安装 API
// ══════════════════════════════════════════════════════��════════

/**
 * POST /api/v1/skill-definitions/install-from-anthropic
 * 从 Anthropic Skill ID 安装
 */
router.post(
  '/install-from-anthropic',
  authenticate,
  requirePermission('admin'),
  combinedRateLimit,
  validate(installFromAnthropicSchema),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const { skillId, version } = req.body

    const packageId = await installFromAnthropicSkillId(skillId, version)
    const pkg = await skillPackageRepo.findById(packageId)

    res.status(201).json({
      success: true,
      data: pkg,
      message: `已从 Anthropic 安装技能 ${skillId}`,
    })
  })
)

/**
 * POST /api/v1/skill-definitions/install-from-manifest
 * 从 Manifest URL 安装
 */
router.post(
  '/install-from-manifest',
  authenticate,
  requirePermission('admin'),
  combinedRateLimit,
  validate(installFromManifestSchema),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const { manifestUrl, skillId } = req.body

    const packageId = await installFromManifestUrl(manifestUrl, skillId)
    const pkg = await skillPackageRepo.findById(packageId)

    res.status(201).json({
      success: true,
      data: pkg,
      message: `已从 Manifest URL 安装技能`,
    })
  })
)

export default router
