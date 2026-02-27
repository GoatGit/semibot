/**
 * Skill Definitions API 路由（新模型）
 *
 * 提供技能定义和安装管理的 API（无版本控制，每次安装覆盖旧包）
 */

import { Router, type Response } from 'express'
import { z } from 'zod'
import fs from 'fs-extra'
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
import { installWithRetry } from '../../services/skill-retry-rollback.service'
import { uploadAndInstall, uploadCreateAndInstall } from '../../services/skill-upload.service'
import { handleFileUpload, type UploadRequest } from '../../middleware/upload'
import { createLogger } from '../../lib/logger'

const router: Router = Router()
const skillDefinitionsLogger = createLogger('skill-definitions-route')

// ═══════════════════════════════════════════════════════════════
// Schema 定义
// ═══════════════════════════════════════════════════════════════

const createSkillDefinitionSchema = z.object({
  skillId: z.string().min(1).max(120).regex(/^[a-zA-Z0-9._:/-]+$/),
  name: z.string().min(1).max(100),
  description: z.string().max(1000).optional(),
  triggerKeywords: z.array(z.string().max(50)).max(20).optional(),
  protocol: z.enum(['anthropic', 'codex', 'semibot']).optional(),
  sourceType: z.enum(['anthropic', 'codex', 'url', 'local', 'git', 'registry', 'upload']).optional(),
  sourceUrl: z.string().url().optional(),
  isPublic: z.boolean().optional(),
})

const updateSkillDefinitionSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(1000).optional(),
  triggerKeywords: z.array(z.string().max(50)).max(20).optional(),
  status: z.enum(['active', 'inactive', 'deprecated']).optional(),
  isActive: z.boolean().optional(),
  isPublic: z.boolean().optional(),
})

const installSkillPackageSchema = z.object({
  sourceType: z.enum(['anthropic', 'codex', 'url', 'local', 'git', 'registry', 'upload']),
  sourceUrl: z.string().url().optional(),
  localPath: z.string().optional(),
  enableRetry: z.boolean().optional(),
})

const installFromAnthropicSchema = z.object({
  skillId: z.string().min(1).max(120).regex(/^[a-zA-Z0-9._:/-]+$/),
})

const installFromManifestSchema = z.object({
  manifestUrl: z.string().url(),
  skillId: z.string().min(1).max(120).optional(),
})

// ═══════════════════════════════════════════════════════════════
// 快捷安装 API（必须在 /:id 路由之前定义，避免路径冲突）
// ═══════════════════════════════════════════════════════════════

/**
 * POST /api/v1/skill-definitions/upload-create
 * 上传即创建：上传安装包 → 解析 SKILL.md → 自动创建/更新 definition + 安装 package
 */
router.post(
  '/upload-create',
  authenticate,
  requirePermission('skills:write'),
  combinedRateLimit,
  handleFileUpload,
  asyncHandler(async (req: UploadRequest & AuthRequest, res: Response) => {
    const uploadedFile = req.uploadedFile
    const fields = req.uploadFields || {}

    if (!uploadedFile) {
      res.status(400).json({
        success: false,
        error: {
          code: 'SKILL_UPLOAD_NO_FILE',
          message: '未检测到上传文件',
        },
      })
      return
    }

    const enableRetry = fields.enableRetry === 'true'

    const result = await uploadCreateAndInstall({
      tempFilePath: uploadedFile.tempPath,
      originalName: uploadedFile.originalName,
      enableRetry,
      createdBy: req.user?.userId,
    })

    const definition = await skillDefinitionRepo.findById(result.definitionId)
    const pkg = await skillPackageRepo.findById(result.packageId)

    res.status(201).json({
      success: true,
      data: {
        definition,
        package: pkg,
        created: result.created,
      },
      message: result.created
        ? `已创建技能定义并安装`
        : `已更新技能定义并重新安装`,
    })
  })
)

/**
 * POST /api/v1/skill-definitions/install/anthropic
 * 从 Anthropic Skill ID 安装
 */
router.post(
  '/install/anthropic',
  authenticate,
  requirePermission('skills:write'),
  combinedRateLimit,
  validate(installFromAnthropicSchema),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const { skillId } = req.body

    const packageId = await installFromAnthropicSkillId(skillId)
    const pkg = await skillPackageRepo.findById(packageId)

    res.status(201).json({
      success: true,
      data: pkg,
      message: `已从 Anthropic 安装技能 ${skillId}`,
    })
  })
)

/**
 * POST /api/v1/skill-definitions/install/manifest
 * 从 Manifest URL 安装
 */
router.post(
  '/install/manifest',
  authenticate,
  requirePermission('skills:write'),
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
  requirePermission('skills:write'),
  combinedRateLimit,
  validate(createSkillDefinitionSchema),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const input = req.body

    const definition = await skillDefinitionRepo.create({
      ...input,
      isPublic: input.isPublic,
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
    const limit = parseInt(req.query.limit as string) || parseInt(req.query.pageSize as string) || 20
    const search = req.query.search as string
    const isActive = req.query.isActive === 'true' ? true : req.query.isActive === 'false' ? false : undefined

    const result = await skillDefinitionRepo.findAll({
      page,
      pageSize: limit,
      search,
      isActive,
    })

    res.json({
      success: true,
      data: result.data,
      meta: {
        total: result.total,
        page: result.page,
        limit,
        totalPages: Math.ceil(result.total / limit),
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
  requirePermission('skills:write'),
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
  requirePermission('skills:write'),
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

    const pkg = await skillPackageRepo.findByDefinition(id)
    if (pkg?.packagePath) {
      try {
        if (await fs.pathExists(pkg.packagePath)) {
          await fs.remove(pkg.packagePath)
        }
      } catch (error) {
        skillDefinitionsLogger.warn('删除技能包目录失败，继续删除数据库记录', {
          id,
          packagePath: pkg.packagePath,
          error: (error as Error).message,
        })
      }
    }

    await skillInstallLogRepo.removeByDefinition(id)
    await skillPackageRepo.removeByDefinition(id)
    const deleted = await skillDefinitionRepo.remove(id)

    if (!deleted) {
      res.status(500).json({
        success: false,
        error: {
          code: 'SKILL_DELETE_FAILED',
          message: '删除技能定义失败',
        },
      })
      return
    }

    res.json({
      success: true,
      data: { id },
    })
  })
)

// ═══════════════════════════════════════════════════════════════
// 安装 API
// ═══════════════════════════════════════════════════════════════

/**
 * POST /api/v1/skill-definitions/:id/install
 * 安装技能包（仅管理员，覆盖式安装）
 */
router.post(
  '/:id/install',
  authenticate,
  requirePermission('skills:write'),
  combinedRateLimit,
  validate(installSkillPackageSchema),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const { id } = req.params
    const input = req.body

    const installInput = {
      skillDefinitionId: id,
      sourceType: input.sourceType,
      sourceUrl: input.sourceUrl,
      localPath: input.localPath,
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
 * POST /api/v1/skill-definitions/:id/upload-install
 * 通过上传压缩包安装技能（仅管理员）
 */
router.post(
  '/:id/upload-install',
  authenticate,
  requirePermission('skills:write'),
  combinedRateLimit,
  handleFileUpload,
  asyncHandler(async (req: UploadRequest & AuthRequest, res: Response) => {
    const { id } = req.params
    const uploadedFile = req.uploadedFile
    const fields = req.uploadFields || {}

    if (!uploadedFile) {
      res.status(400).json({
        success: false,
        error: {
          code: 'SKILL_UPLOAD_NO_FILE',
          message: '未检测到上传文件',
        },
      })
      return
    }

    const enableRetry = fields.enableRetry === 'true'

    const packageId = await uploadAndInstall({
      skillDefinitionId: id,
      tempFilePath: uploadedFile.tempPath,
      originalName: uploadedFile.originalName,
      enableRetry,
    })

    const pkg = await skillPackageRepo.findById(packageId)

    res.status(201).json({
      success: true,
      data: pkg,
      message: `已通过上传安装技能`,
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

export default router
