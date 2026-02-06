/**
 * Organizations 路由
 *
 * 处理组织信息和成员管理的 API 端点
 */

import { Router, type Response } from 'express'
import { z } from 'zod'
import * as organizationService from '../../services/organization.service'
import { authenticate, type AuthRequest } from '../../middleware/auth'
import { ERROR_HTTP_STATUS, ERROR_MESSAGES, VALIDATION_FAILED } from '../../constants/errorCodes'

const router: Router = Router()

// ═══════════════════════════════════════════════════════════════
// 请求验证 Schema
// ═══════════════════════════════════════════════════════════════

const updateOrgSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  settings: z.record(z.unknown()).optional(),
})

const listMembersSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
  cursor: z.string().optional(),
})

// ═══════════════════════════════════════════════════════════════
// 辅助函数
// ═══════════════════════════════════════════════════════════════

function handleError(res: Response, error: unknown): void {
  if (error && typeof error === 'object' && 'code' in error) {
    const code = (error as { code: string }).code
    const status = ERROR_HTTP_STATUS[code] ?? 400
    const message = ERROR_MESSAGES[code] ?? '请求失败'

    res.status(status).json({
      success: false,
      error: { code, message },
    })
    return
  }

  console.error('[Organizations] 未预期的错误:', error)
  res.status(500).json({
    success: false,
    error: { code: 'INTERNAL_ERROR', message: '服务内部错误' },
  })
}

// ═══════════════════════════════════════════════════════════════
// 路由处理
// ═══════════════════════════════════════════════════════════════

/**
 * GET /organizations/current
 * 获取当前组织信息
 */
router.get('/current', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const org = await organizationService.getCurrentOrganization(req.user!.orgId)

    res.json({
      success: true,
      data: {
        id: org.id,
        name: org.name,
        slug: org.slug,
        plan: org.plan,
        quota: org.quota,
        settings: org.settings,
        ownerId: org.ownerId,
        isActive: org.isActive,
        createdAt: org.createdAt,
      },
    })
  } catch (error) {
    handleError(res, error)
  }
})

/**
 * PUT /organizations/current
 * 更新当前组织信息
 */
router.put('/current', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const validation = updateOrgSchema.safeParse(req.body)

    if (!validation.success) {
      res.status(400).json({
        success: false,
        error: {
          code: VALIDATION_FAILED,
          message: '数据校验失败',
          details: validation.error.errors.map((e) => ({
            field: e.path.join('.'),
            message: e.message,
          })),
        },
      })
      return
    }

    const org = await organizationService.updateOrganization(
      req.user!.orgId,
      req.user!.userId,
      req.user!.role,
      validation.data
    )

    res.json({
      success: true,
      data: {
        id: org.id,
        name: org.name,
        slug: org.slug,
        settings: org.settings,
        updatedAt: new Date().toISOString(),
      },
    })
  } catch (error) {
    handleError(res, error)
  }
})

/**
 * GET /organizations/current/members
 * 获取组织成员列表
 */
router.get('/current/members', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const validation = listMembersSchema.safeParse(req.query)

    if (!validation.success) {
      res.status(400).json({
        success: false,
        error: {
          code: VALIDATION_FAILED,
          message: '数据校验失败',
          details: validation.error.errors.map((e) => ({
            field: e.path.join('.'),
            message: e.message,
          })),
        },
      })
      return
    }

    const { limit, cursor } = validation.data

    const result = await organizationService.getOrganizationMembers(req.user!.orgId, {
      limit,
      cursor,
    })

    res.json({
      success: true,
      data: result.members.map((m) => ({
        id: m.id,
        email: m.email,
        name: m.name,
        role: m.role,
        joinedAt: m.joinedAt,
        lastLoginAt: m.lastLoginAt,
      })),
      meta: {
        nextCursor: result.nextCursor,
      },
    })
  } catch (error) {
    handleError(res, error)
  }
})

export default router
