/**
 * Evolution System Type Definitions
 *
 * Types for the Agent self-evolution system, including evolved skills,
 * evolution logs, and configuration.
 */

// =============================================================================
// Evolved Skill
// =============================================================================

export type EvolvedSkillStatus =
  | 'pending_review'
  | 'approved'
  | 'rejected'
  | 'auto_approved'
  | 'deprecated'

export interface EvolvedSkillStep {
  order: number
  action: string
  tool: string
  paramsTemplate: Record<string, unknown>
}

export interface EvolvedSkillParam {
  type: string
  description: string
  required: boolean
}

export interface EvolvedSkill {
  id: string
  orgId: string
  agentId: string
  sessionId: string
  name: string
  description: string
  triggerKeywords: string[]
  steps: EvolvedSkillStep[]
  toolsUsed: string[]
  parameters: Record<string, EvolvedSkillParam>
  preconditions: Record<string, unknown>
  expectedOutcome: string | null
  embedding: number[] | null
  qualityScore: number
  reusabilityScore: number
  status: EvolvedSkillStatus
  useCount: number
  successCount: number
  lastUsedAt: string | null
  reviewedBy: string | null
  reviewedAt: string | null
  reviewComment: string | null
  version: number
  createdAt: string
  updatedAt: string
  deletedAt: string | null
  deletedBy: string | null
}

// =============================================================================
// Evolution Log
// =============================================================================

export type EvolutionStage = 'extract' | 'validate' | 'register' | 'index'
export type EvolutionLogStatus = 'started' | 'completed' | 'failed' | 'skipped'

export interface EvolutionLog {
  id: string
  orgId: string
  agentId: string
  sessionId: string
  stage: EvolutionStage
  status: EvolutionLogStatus
  evolvedSkillId: string | null
  inputData: Record<string, unknown> | null
  outputData: Record<string, unknown> | null
  errorMessage: string | null
  durationMs: number | null
  tokensUsed: number
  createdAt: string
}

// =============================================================================
// Evolution Config (stored in agents.config.evolution JSONB)
// =============================================================================

export interface EvolutionConfig {
  enabled: boolean
  autoApprove: boolean
  minQualityScore: number
  maxEvolvePerHour: number
  cooldownMinutes: number
}

// =============================================================================
// Evolution DTOs
// =============================================================================

export interface CreateEvolvedSkillInput {
  orgId: string
  agentId: string
  sessionId: string
  name: string
  description: string
  triggerKeywords?: string[]
  steps: EvolvedSkillStep[]
  toolsUsed: string[]
  parameters?: Record<string, EvolvedSkillParam>
  preconditions?: Record<string, unknown>
  expectedOutcome?: string
  qualityScore: number
  reusabilityScore: number
  status: EvolvedSkillStatus
}

export interface ReviewEvolvedSkillInput {
  action: 'approve' | 'reject'
  comment?: string
}

export interface UpdateEvolutionConfigInput {
  enabled?: boolean
  autoApprove?: boolean
  minQualityScore?: number
  maxEvolvePerHour?: number
  cooldownMinutes?: number
}

export interface EvolutionStatsResponse {
  totalEvolved: number
  approvedCount: number
  rejectedCount: number
  pendingCount: number
  approvalRate: number
  totalReuseCount: number
  avgQualityScore: number
  topSkills: TopEvolvedSkill[]
}

export interface TopEvolvedSkill {
  id: string
  name: string
  useCount: number
  successRate: number
}
