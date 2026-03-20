/**
 * Agent Studio 相关类型定义
 */

export interface StudioInputHint {
  label: string
  description?: string
}

export interface StudioSchema {
  inputs: StudioInputHint[]
}

export interface AgentNode {
  id: string
  agentId: string
  position: { x: number; y: number }
}

export interface StudioEdge {
  id: string
  source: string
  target: string
}

export type StudioStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'

export interface NodeOutput {
  text: string
  files: { url: string; filename: string; mimeType: string }[]
}

export interface NodeResult {
  status: 'pending' | 'running' | 'completed' | 'failed'
  sessionId?: string
  output?: NodeOutput
  error?: string
  startedAt?: string
  completedAt?: string
}

export interface Studio {
  id: string
  name: string
  description?: string
  nodes: AgentNode[]
  edges: StudioEdge[]
  isActive: boolean
  createdAt: string
  updatedAt: string
}

export interface StudioRun {
  id: string
  studioId: string
  status: StudioStatus
  inputs: Record<string, unknown>
  currentNodeId?: string
  nodeResults: Record<string, NodeResult>
  error?: string
  createdAt: string
  completedAt?: string
}

export interface CreateStudioInput {
  name: string
  description?: string
  nodes?: AgentNode[]
  edges?: StudioEdge[]
}

export interface UpdateStudioInput {
  name?: string
  description?: string
  nodes?: AgentNode[]
  edges?: StudioEdge[]
  isActive?: boolean
}

export interface TriggerStudioRunInput {
  inputs?: Record<string, unknown>
}
