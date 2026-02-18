/**
 * Evolution Webhook Events
 *
 * 进化系统事件定义和触发器
 */

import { createLogger } from '../lib/logger'
import * as WebhookService from '../services/webhook.service'

const logger = createLogger('evolution-events')

// ═══════════════════════════════════════════════════════════════
// 事件类型定义
// ═══════════════════════════════════════════════════════════════

export const EVOLUTION_EVENTS = {
  TRIGGERED: 'evolution.triggered',
  SKILL_CREATED: 'evolution.skill_created',
  SKILL_APPROVED: 'evolution.skill_approved',
  SKILL_REJECTED: 'evolution.skill_rejected',
  SKILL_DEPRECATED: 'evolution.skill_deprecated',
  SKILL_PROMOTED: 'evolution.skill_promoted',
} as const

export type EvolutionEventType = typeof EVOLUTION_EVENTS[keyof typeof EVOLUTION_EVENTS]

export interface EvolutionEventData {
  agentId: string
  sessionId?: string
  skillId?: string
  skillName?: string
  qualityScore?: number
  status?: string
  reviewedBy?: string
  comment?: string
}

export interface EvolutionEvent {
  type: EvolutionEventType
  timestamp: string
  orgId: string
  data: EvolutionEventData
}

// ═══════════════════════════════════════════════════════════════
// 事件触发器
// ═══════════════════════════════════════════════════════════════

export class EvolutionEventEmitter {
  /**
   * 触发进化事件（日志记录，预留 Webhook 分发）
   */
  static async emit(
    type: EvolutionEventType,
    orgId: string,
    data: EvolutionEventData
  ): Promise<void> {
    const event: EvolutionEvent = {
      type,
      timestamp: new Date().toISOString(),
      orgId,
      data,
    }

    logger.info('[Evolution] Webhook 事件触发', {
      type: event.type,
      orgId,
      skillId: data.skillId,
    })

    try {
      await WebhookService.dispatch(orgId, {
        type: event.type,
        timestamp: event.timestamp,
        orgId: event.orgId,
        data: event.data as unknown as Record<string, unknown>,
      })
    } catch (error) {
      logger.error('[Evolution] Webhook 分发失败', { type, error })
    }
  }

  static async emitSkillCreated(orgId: string, skill: {
    id: string; agentId: string; sessionId: string; name: string; qualityScore: number; status: string
  }): Promise<void> {
    await this.emit(EVOLUTION_EVENTS.SKILL_CREATED, orgId, {
      agentId: skill.agentId,
      sessionId: skill.sessionId,
      skillId: skill.id,
      skillName: skill.name,
      qualityScore: skill.qualityScore,
      status: skill.status,
    })
  }

  static async emitSkillApproved(orgId: string, skill: {
    id: string; agentId: string; name: string
  }, reviewedBy: string): Promise<void> {
    await this.emit(EVOLUTION_EVENTS.SKILL_APPROVED, orgId, {
      agentId: skill.agentId,
      skillId: skill.id,
      skillName: skill.name,
      reviewedBy,
    })
  }

  static async emitSkillRejected(orgId: string, skill: {
    id: string; agentId: string; name: string
  }, reviewedBy: string, comment?: string): Promise<void> {
    await this.emit(EVOLUTION_EVENTS.SKILL_REJECTED, orgId, {
      agentId: skill.agentId,
      skillId: skill.id,
      skillName: skill.name,
      reviewedBy,
      comment,
    })
  }

  static async emitSkillDeprecated(orgId: string, skill: {
    id: string; agentId: string; name: string
  }): Promise<void> {
    await this.emit(EVOLUTION_EVENTS.SKILL_DEPRECATED, orgId, {
      agentId: skill.agentId,
      skillId: skill.id,
      skillName: skill.name,
    })
  }

  static async emitSkillPromoted(orgId: string, skill: {
    id: string; agentId: string; name: string
  }): Promise<void> {
    await this.emit(EVOLUTION_EVENTS.SKILL_PROMOTED, orgId, {
      agentId: skill.agentId,
      skillId: skill.id,
      skillName: skill.name,
    })
  }
}
