export type CapabilityKind = 'tool' | 'sub_agent'

export type CapabilityRiskLevel = 'low' | 'medium' | 'high'

export type CapabilitySource =
  | { type: 'builtin'; key: string }
  | { type: 'cli'; providerId: string; packageId?: string | null; actualToolName: string }
  | { type: 'mcp'; serverId: string; serverName: string; toolName: string }
  | { type: 'agent'; agentId: string }

export interface CapabilityDescriptor {
  id: string
  kind: CapabilityKind
  name: string
  displayName: string
  description: string
  orgId?: string
  source: CapabilitySource
  inputSchema?: Record<string, unknown>
  outputSchema?: Record<string, unknown>
  riskLevel: CapabilityRiskLevel
  requiresApproval: boolean
  approvalPolicyKey?: string
  visibility: {
    planner: boolean
    executor: boolean
    audit: boolean
  }
  constraints?: {
    timeoutMs?: number
    maxRetries?: number
    concurrencyKey?: string
    sideEffectLevel?: 'read' | 'write' | 'external_write'
  }
  tags?: string[]
  metadata?: Record<string, unknown>
}

export interface SkillContextBinding {
  skillId: string
  skillDefinitionId?: string
  skillPackageId?: string
  description?: string
  hasSkillMd: boolean
  scriptFiles?: string[]
  packageFiles?: string[]
  selectedByPlanner?: boolean
  metadata?: Record<string, unknown>
}

export interface RuntimeActionRequest {
  actionId: string
  stepId: string
  capabilityId: string
  capabilityName: string
  arguments: Record<string, unknown>
  requestedBy: {
    sessionId: string
    agentId: string
    userId: string
  }
}

export interface RuntimeActionResult {
  actionId: string
  capabilityId: string
  status: 'success' | 'failed' | 'rejected' | 'timeout'
  output?: Record<string, unknown>
  error?: {
    code: string
    message: string
    retryable: boolean
  }
  usage?: Record<string, unknown>
  startedAt?: string
  finishedAt?: string
  durationMs?: number
}
