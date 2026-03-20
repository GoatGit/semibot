/**
 * LLM Providers API 路由
 *
 * 从环境变量配置的 LLM Providers 获取可用模型
 */

import { Router, type Response } from 'express'
import { authenticate, type AuthRequest } from '../../middleware/auth'
import { asyncHandler } from '../../middleware/errorHandler'
import { combinedRateLimit } from '../../middleware/rateLimit'
import { getProviderStatus } from '../../services/llm.service'

const router: Router = Router()

const PROVIDER_DISPLAY_NAMES: Record<string, string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  google: 'Google AI',
  custom: '自定义模型',
}

// ═══════════════════════════════════════════════════════════════
// 路由
// ═══════════════════════════════════════════════════════════════

/**
 * GET /llm-providers - 获取可用的 LLM Providers 列表
 */
router.get(
  '/',
  authenticate,
  combinedRateLimit,
  asyncHandler(async (_req: AuthRequest, res: Response) => {
    const providers = await getProviderStatus()

    const data = providers
      .filter((p) => p.available)
      .map((p) => ({
        name: p.name,
        displayName: PROVIDER_DISPLAY_NAMES[p.name] || p.name,
        available: p.available,
        models: p.models,
      }))

    res.json({
      success: true,
      data,
    })
  })
)

/**
 * GET /llm-providers/models - 获取可用的 LLM 模型列表
 */
router.get(
  '/models',
  authenticate,
  combinedRateLimit,
  asyncHandler(async (_req: AuthRequest, res: Response) => {
    const providers = await getProviderStatus()

    // 构建带 Provider 信息的模型列表
    const models: Array<{
      modelId: string
      displayName: string
      displayNameSource: 'provider' | 'fallback'
      providerName: string
      providerType: string
    }> = []

    for (const provider of providers) {
      if (!provider.available) continue

      for (const modelInfo of provider.modelInfos) {
        const modelId = modelInfo.id
        const displayName = modelInfo.displayName ?? modelId
        models.push({
          modelId,
          displayName,
          displayNameSource: modelInfo.displayName ? 'provider' : 'fallback',
          providerName: PROVIDER_DISPLAY_NAMES[provider.name] || provider.name,
          providerType: provider.name,
        })
      }
    }

    res.json({
      success: true,
      data: models,
    })
  })
)

/**
 * GET /llm-providers/status - 获取所有 Provider 状态（包括未配置的）
 */
router.get(
  '/status',
  authenticate,
  combinedRateLimit,
  asyncHandler(async (_req: AuthRequest, res: Response) => {
    const providers = await getProviderStatus()

    const data = providers.map((p) => ({
      name: p.name,
      displayName: PROVIDER_DISPLAY_NAMES[p.name] || p.name,
      available: p.available,
      models: p.models,
    }))

    res.json({
      success: true,
      data,
    })
  })
)

export default router
