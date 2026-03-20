/**
 * Agent-related type definitions
 *
 * Based on docs/design/DATA_MODEL.md
 */

// =============================================================================
// Agent Configuration
// =============================================================================

/**
 * Per-role model and temperature override for a single orchestrator role
 */
export interface NodeModelConfig {
  /** Model identifier override for this role */
  model?: string;
  /** Temperature override for this role (0-2) */
  temperature?: number;
}

/**
 * Per-role model configuration. Each role can independently override
 * the global model and temperature set in AgentModelConfig.
 *
 * Roles:
 * - plan: PLAN node (planner LLM, benefits from stronger reasoning models)
 * - act: ACT / RESPOND nodes and memory service (shared; memory always uses temperature=0)
 * - textProcessing: text_processing builtin tool (can use a lighter model)
 */
export interface ModelRoleConfig {
  plan?: NodeModelConfig;
  act?: NodeModelConfig;
  textProcessing?: NodeModelConfig;
}

/**
 * LLM model configuration for an Agent
 */
export interface AgentModelConfig {
  /** Model identifier (e.g., 'gpt-4o', 'claude-3-sonnet') — global fallback */
  model: string;
  /** Sampling temperature (0-2) — global fallback */
  temperature: number;
  /** Maximum tokens for response */
  maxTokens: number;
  /** Request timeout in seconds */
  timeoutSeconds: number;
  /** Number of retry attempts on failure */
  retryAttempts?: number;
  /** Fallback model if primary fails */
  fallbackModel?: string;
  /** Per-role model and temperature overrides. Takes precedence over global model/temperature. */
  modelRoles?: ModelRoleConfig;
  /** Agent Studio 接口配置（可选），用于画布节点显示期望输入说明 */
  studioSchema?: import('./studio').StudioSchema;
}

/**
 * Agent subscription plan types
 */
export type AgentPlan = 'free' | 'pro' | 'enterprise';

/**
 * Agent status
 */
export type AgentStatus = 'active' | 'inactive' | 'archived';

// =============================================================================
// Agent Entity
// =============================================================================

/**
 * Agent definition entity
 *
 * Represents an AI agent that can be configured with skills,
 * sub-agents, and custom system prompts.
 */
export interface Agent {
  /** Unique identifier (UUID) */
  id: string;
  /** Display name */
  name: string;
  /** Description of agent's purpose */
  description?: string;
  /** System prompt for LLM */
  systemPrompt: string;
  /** Model configuration */
  config: AgentModelConfig;
  /** List of skill IDs */
  skills: string[];
  /** List of sub-agent IDs for delegation */
  subAgents: string[];
  /** Current version number */
  version: number;
  /** Whether agent is active */
  isActive: boolean;
  /** Whether agent is publicly accessible */
  isPublic: boolean;
  /** Whether this is a system-level agent */
  isSystem?: boolean;
  /** Creation timestamp */
  createdAt: string;
  /** Last update timestamp */
  updatedAt: string;
}

/**
 * Agent version history record
 */
export interface AgentVersion {
  /** Unique identifier */
  id: string;
  /** Parent agent ID */
  agentId: string;
  /** Version number */
  version: number;
  /** System prompt at this version */
  systemPrompt: string;
  /** Configuration at this version */
  config: AgentModelConfig;
  /** Skills at this version */
  skills: string[];
  /** Sub-agents at this version */
  subAgents: string[];
  /** Change description */
  changeLog?: string;
  /** User who created this version */
  createdBy?: string;
  /** Creation timestamp */
  createdAt: string;
}

// =============================================================================
// Skill & Tool Types
// =============================================================================

/**
 * Tool types supported by the platform
 */
export type ToolType = 'api' | 'code' | 'query' | 'mcp' | 'browser';

/**
 * Tool parameter schema (OpenAPI-style)
 */
export interface ToolParameterSchema {
  type: 'object';
  properties: Record<string, {
    type: 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object';
    description?: string;
    default?: unknown;
    enum?: string[];
  }>;
  required?: string[];
}

/**
 * Tool schema definition (OpenAI Function Calling format)
 */
export interface ToolSchema {
  name: string;
  description: string;
  parameters: ToolParameterSchema;
}

/**
 * Tool definition entity
 */
export interface Tool {
  id: string;
  orgId?: string;
  name: string;
  type: ToolType;
  description?: string;
  schema: ToolSchema;
  implementation: Record<string, unknown>;
  isBuiltin: boolean;
  isActive: boolean;
  createdBy?: string;
  createdAt: string;
  updatedAt: string;
}

// =============================================================================
// Agent Execution States
// =============================================================================

/**
 * Agent orchestrator states (state machine)
 *
 * Based on docs/design/ARCHITECTURE.md Section 4.1
 */
export type AgentState =
  | 'START'
  | 'THINK'
  | 'ACT'
  | 'DELEGATE'
  | 'RESPOND'
  | 'END';

/**
 * Action types during agent execution
 */
export type AgentActionType =
  | 'tool_call'
  | 'skill_call'
  | 'delegate'
  | 'llm_call';
