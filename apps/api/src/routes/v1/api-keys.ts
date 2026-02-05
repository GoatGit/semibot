/**
 * API Keys 路由
 *
 * 处理 API Key 管理的 API 端点
 */

import { Router, type Response } from 'express'
import { z } from 'zod'
import * as apiKeysService from '../../services/api-keys.service'
import { authenticate, type AuthRequest } from '../../middleware/auth'
import { ERROR_HTTP_STATUS, ERROR_MESSAGES, VALIDATION_FAILED } from '../../constants/errorCodes'

const router: Router = Router()

// ═══════════════════════════════════════════════════════════════
// 请求验证 Schema
// ═══════════════════════════════════════════════════════════════

const createApiKeySchema = z.object({
  name: z.string().min(1, '名称不能为空').max(100, '名称最长100字符'),
  permissions: z.array(z.string()).optional(),
  expires_at: z.string().datetime().optional(),
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

  console.error('[ApiKeys] 未预期的错误:', error)
  res.status(500).json({
    success: false,
    error: { code: 'INTERNAL_ERROR', message: '服务内部错误' },
  })
}

// ═══════════════════════════════════════════════════════════════
// 路由处理
// ═══════════════════════════════════════════════════════════════

/**
 * POST /api-keys
 * 创建 API Key
 */
router.post('/', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const validation = createApiKeySchema.safeParse(req.body)

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

    const { name, permissions, expires_at } = validation.data

    const apiKey = await apiKeysService.createApiKey(req.user!.orgId, req.user!.userId, {
      name,
      permissions,
      expiresAt: expires_at,
    })

    res.status(201).json({
      success: true,
      data: {
        id: apiKey.id,
        name: apiKey.name,
        key: apiKey.key, // 完整密钥只在创建时返回一次
        key_prefix: apiKey.keyPrefix,
        permissions: apiKey.permissions,
        expires_at: apiKey.expiresAt,
        created_at: apiKey.createdAt,
      },
    })
  } catch (error) {
    handleError(res, error)
  }
})

/**
 * GET /api-keys
 * 列出 API Keys
 */
router.get('/', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const keys = await apiKeysService.listApiKeys(req.user!.orgId)

    res.json({
      success: true,
      data: keys.map((k) => ({
        id: k.id,
        name: k.name,
        key_prefix: k.keyPrefix,
        permissions: k.permissions,
        last_used_at: k.lastUsedAt,
        expires_at: k.expiresAt,
        is_active: k.isActive,
      })),
    })
  } catch (error) {
    handleError(res, error)
  }
})

/**
 * DELETE /api-keys/:id
 * 删除 API Key
 */
router.delete('/:id', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    await apiKeysService.deleteApiKey(
      req.user!.orgId,
      req.user!.userId,
      req.user!.role,
      req.params.id
    )

    res.json({
      success: true,
      data: {
        deleted: true,
      },
    })
  } catch (error) {
    handleError(res, error)
  }
})

export default router
