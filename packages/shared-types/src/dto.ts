/**
 * Data Transfer Object (DTO) type definitions
 *
 * These types represent the input/output contracts for API requests,
 * ensuring consistency between frontend and backend.
 */

import type { SessionStatus } from './session';
import type { MessageRole, ToolCall } from './message';

// =============================================================================
// Agent DTOs
// =============================================================================

/**
 * Agent model configuration input (all fields optional with defaults)
 */
export interface AgentModelConfigInput {
  /** Model identifier (e.g., 'gpt-4o', 'claude-3-sonnet') */
  model?: string;
  /** Sampling temperature (0-2) */
  temperature?: number;
  /** Maximum tokens for response */
  maxTokens?: number;
  /** Request timeout in seconds */
  timeoutSeconds?: number;
  /** Number of retry attempts on failure */
  retryAttempts?: number;
  /** Fallback model if primary fails */
  fallbackModel?: string;
}

/**
 * Create Agent request DTO
 */
export interface CreateAgentInput {
  /** Display name */
  name: string;
  /** Description of agent's purpose */
  description?: string;
  /** System prompt for LLM */
  systemPrompt: string;
  /** Model configuration (optional, uses defaults) */
  config?: AgentModelConfigInput;
  /** List of skill IDs */
  skills?: string[];
  /** List of sub-agent IDs for delegation */
  subAgents?: string[];
  /** Whether agent is publicly accessible */
  isPublic?: boolean;
}

/**
 * Update Agent request DTO
 */
export interface UpdateAgentInput {
  /** Display name */
  name?: string;
  /** Description of agent's purpose */
  description?: string;
  /** System prompt for LLM */
  systemPrompt?: string;
  /** Model configuration */
  config?: AgentModelConfigInput;
  /** List of skill IDs */
  skills?: string[];
  /** List of sub-agent IDs for delegation */
  subAgents?: string[];
  /** Whether agent is active */
  isActive?: boolean;
  /** Whether agent is publicly accessible */
  isPublic?: boolean;
}

// =============================================================================
// Session DTOs
// =============================================================================

/**
 * Create Session request DTO
 */
export interface CreateSessionInput {
  /** Agent ID */
  agentId: string;
  /** Session title */
  title?: string;
  /** Additional metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Update Session request DTO
 * Note: Only title and status can be updated
 */
export interface UpdateSessionInput {
  /** Session title */
  title?: string;
  /** Session status */
  status?: SessionStatus;
}

// =============================================================================
// Message DTOs
// =============================================================================

/**
 * Add Message request DTO
 */
export interface AddMessageInput {
  /** Message role */
  role: MessageRole;
  /** Message content */
  content: string;
  /** Parent message ID (for branching conversations) */
  parentMessageId?: string;
  /** Tool calls made by assistant */
  toolCalls?: ToolCall[];
  /** Tool call ID (for tool role messages) */
  toolCallId?: string;
  /** Additional metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Chat message request DTO
 */
export interface ChatMessageInput {
  /** User message content */
  message: string;
  /** Parent message ID (for branching) */
  parentMessageId?: string;
}

/**
 * Start chat request DTO
 */
export interface StartChatInput {
  /** Agent ID */
  agentId: string;
  /** User message content */
  message: string;
}

// =============================================================================
// Skill DTOs
// =============================================================================

/**
 * Tool reference in skill
 */
export interface SkillToolInput {
  /** Tool name */
  name: string;
  /** Tool type */
  type: 'function' | 'mcp';
  /** Tool configuration */
  config?: Record<string, unknown>;
}

/**
 * Skill package status
 */
export type SkillPackageStatus =
  | 'pending'       // 等待处理
  | 'downloading'   // 下载中
  | 'validating'    // 校验中
  | 'installing'    // 安装中
  | 'active'        // 已激活
  | 'failed'        // 失败
  | 'deprecated';   // 已废弃

/**
 * Skill package source type
 */
export type SkillSourceType =
  | 'git'           // Git 仓库
  | 'url'           // HTTP(S) URL
  | 'registry'      // 技能注册中心
  | 'local'         // 本地文件
  | 'anthropic';    // Anthropic Skills

/**
 * Skill install operation type
 */
export type SkillInstallOperation =
  | 'install'       // 安装
  | 'update'        // 更新
  | 'rollback'      // 回滚
  | 'uninstall';    // 卸载

/**
 * Skill install log status
 */
export type SkillInstallLogStatus =
  | 'pending'       // 等待中
  | 'running'       // 运行中
  | 'success'       // 成功
  | 'failed';       // 失败

/**
 * Skill Definition - 平台级技能定义（管理员管理，全租户可见）
 */
export interface SkillDefinition {
  /** 技能定义唯一标识 */
  id: string;
  /** 技能标识符（如 text-editor, code-analyzer） */
  skillId: string;
  /** 技能名称 */
  name: string;
  /** 技能描述 */
  description?: string;
  /** 触发关键词 */
  triggerKeywords: string[];
  /** 技能分类 */
  category?: string;
  /** 标签 */
  tags: string[];
  /** 图标 URL */
  iconUrl?: string;
  /** 作者 */
  author?: string;
  /** 主页 URL */
  homepageUrl?: string;
  /** 文档 URL */
  documentationUrl?: string;
  /** 当前激活版本 */
  currentVersion?: string;
  /** 是否启用 */
  isActive: boolean;
  /** 是否公开（全租户可见） */
  isPublic: boolean;
  /** 创建者 ID */
  createdBy?: string;
  /** 创建时间 */
  createdAt: string;
  /** 更新时间 */
  updatedAt: string;
}

/**
 * Skill Package - 可执行目录包（按版本存储）
 */
export interface SkillPackage {
  /** 包记录唯一标识 */
  id: string;
  /** 关联的技能定义 ID */
  skillDefinitionId: string;
  /** 版本号 */
  version: string;
  /** 来源类型 */
  sourceType: SkillSourceType;
  /** 来源 URL */
  sourceUrl?: string;
  /** 来源引用（git commit/tag/branch） */
  sourceRef?: string;
  /** Manifest URL */
  manifestUrl?: string;
  /** Manifest 内容 */
  manifestContent?: Record<string, unknown>;
  /** 包存储路径 */
  packagePath: string;
  /** SHA256 校验值 */
  checksumSha256: string;
  /** 文件大小（字节） */
  fileSizeBytes?: number;
  /** 状态 */
  status: SkillPackageStatus;
  /** 校验结果 */
  validationResult?: {
    hasSkillMd: boolean;
    hasScripts: boolean;
    hasReferences: boolean;
    entryFile?: string;
    errors?: string[];
    warnings?: string[];
  };
  /** 工具配置列表 */
  tools: SkillToolInput[];
  /** 包配置 */
  config: Record<string, unknown>;
  /** 安装完成时间 */
  installedAt?: string;
  /** 安装者 ID */
  installedBy?: string;
  /** 废弃时间 */
  deprecatedAt?: string;
  /** 废弃原因 */
  deprecatedReason?: string;
  /** 创建时间 */
  createdAt: string;
  /** 更新时间 */
  updatedAt: string;
}

/**
 * Skill Install Log - 安装日志
 */
export interface SkillInstallLog {
  /** 日志记录唯一标识 */
  id: string;
  /** 关联的包记录 ID */
  skillPackageId: string;
  /** 关联的技能定义 ID */
  skillDefinitionId: string;
  /** 操作类型 */
  operation: SkillInstallOperation;
  /** 状态 */
  status: SkillInstallLogStatus;
  /** 当前步骤 */
  step?: string;
  /** 进度百分比（0-100） */
  progress: number;
  /** 日志消息 */
  message?: string;
  /** 错误码 */
  errorCode?: string;
  /** 错误详情 */
  errorMessage?: string;
  /** 错误堆栈 */
  errorStack?: string;
  /** 元数��� */
  metadata: Record<string, unknown>;
  /** 开始时间 */
  startedAt: string;
  /** 完成时间 */
  completedAt?: string;
  /** 耗时（毫秒） */
  durationMs?: number;
  /** 操作者 ID */
  installedBy?: string;
  /** 创建时间 */
  createdAt: string;
}

/**
 * Create Skill Definition request DTO
 */
export interface CreateSkillDefinitionInput {
  /** 技能标识符 */
  skillId: string;
  /** 技能名称 */
  name: string;
  /** 技能描述 */
  description?: string;
  /** 触发关键词 */
  triggerKeywords?: string[];
  /** 技能分类 */
  category?: string;
  /** 标签 */
  tags?: string[];
  /** 图标 URL */
  iconUrl?: string;
  /** 作者 */
  author?: string;
  /** 主页 URL */
  homepageUrl?: string;
  /** 文档 URL */
  documentationUrl?: string;
}

/**
 * Update Skill Definition request DTO
 */
export interface UpdateSkillDefinitionInput {
  /** 技能名称 */
  name?: string;
  /** 技能描述 */
  description?: string;
  /** 触发关键词 */
  triggerKeywords?: string[];
  /** 技能分类 */
  category?: string;
  /** 标签 */
  tags?: string[];
  /** 图标 URL */
  iconUrl?: string;
  /** 作者 */
  author?: string;
  /** 主页 URL */
  homepageUrl?: string;
  /** 文档 URL */
  documentationUrl?: string;
  /** 是否启用 */
  isActive?: boolean;
}

/**
 * Install Skill Package request DTO
 */
export interface InstallSkillPackageInput {
  /** 技能定义 ID */
  skillDefinitionId: string;
  /** 版本号 */
  version: string;
  /** 来源类型 */
  sourceType: SkillSourceType;
  /** 来源 URL */
  sourceUrl?: string;
  /** 来源引用 */
  sourceRef?: string;
  /** Manifest URL */
  manifestUrl?: string;
  /** 工具配置 */
  tools?: SkillToolInput[];
  /** 包配置 */
  config?: Record<string, unknown>;
}

/**
 * Publish Skill Version request DTO
 */
export interface PublishSkillVersionInput {
  /** 版本号 */
  version: string;
  /** 来源类型 */
  sourceType: SkillSourceType;
  /** 来源 URL */
  sourceUrl?: string;
  /** 来源引用 */
  sourceRef?: string;
  /** Manifest URL */
  manifestUrl?: string;
  /** 发布说明 */
  releaseNotes?: string;
}

/**
 * Rollback Skill Version request DTO
 */
export interface RollbackSkillVersionInput {
  /** 目标版本号 */
  targetVersion: string;
  /** 回滚原因 */
  reason?: string;
}

/**
 * Create Skill request DTO (Legacy - 向后兼容)
 */
export interface CreateSkillInput {
  /** Skill name */
  name: string;
  /** Skill description */
  description?: string;
  /** Trigger keywords */
  triggerKeywords?: string[];
  /** Tools used by skill */
  tools?: SkillToolInput[];
  /** Skill configuration */
  config?: {
    maxExecutionTime?: number;
    retryAttempts?: number;
    requiresApproval?: boolean;
  };
}

/**
 * Update Skill request DTO (Legacy - 向后兼容)
 */
export interface UpdateSkillInput {
  /** Skill name */
  name?: string;
  /** Skill description */
  description?: string;
  /** Trigger keywords */
  triggerKeywords?: string[];
  /** Tools used by skill */
  tools?: SkillToolInput[];
  /** Skill configuration */
  config?: {
    maxExecutionTime?: number;
    retryAttempts?: number;
    requiresApproval?: boolean;
  };
  /** Whether skill is active */
  isActive?: boolean;
}

// =============================================================================
// Tool DTOs
// =============================================================================

/**
 * Create Tool request DTO
 */
export interface CreateToolInput {
  /** Tool name */
  name: string;
  /** Tool description */
  description?: string;
  /** Tool type */
  type: string;
  /** Tool schema */
  schema?: {
    parameters?: Record<string, unknown>;
    returns?: Record<string, unknown>;
  };
  /** Tool configuration */
  config?: {
    timeout?: number;
    retryAttempts?: number;
    requiresApproval?: boolean;
    rateLimit?: number;
  };
}

/**
 * Update Tool request DTO
 */
export interface UpdateToolInput {
  /** Tool name */
  name?: string;
  /** Tool description */
  description?: string;
  /** Tool type */
  type?: string;
  /** Tool schema */
  schema?: {
    parameters?: Record<string, unknown>;
    returns?: Record<string, unknown>;
  };
  /** Tool configuration */
  config?: {
    timeout?: number;
    retryAttempts?: number;
    requiresApproval?: boolean;
    rateLimit?: number;
  };
  /** Whether tool is active */
  isActive?: boolean;
}

// =============================================================================
// MCP Server DTOs
// =============================================================================

/**
 * MCP transport types
 */
export type McpTransport = 'stdio' | 'http' | 'websocket';

/**
 * MCP auth types
 */
export type McpAuthType = 'none' | 'api_key' | 'oauth';

/**
 * Create MCP Server request DTO
 */
export interface CreateMcpServerInput {
  /** Server name */
  name: string;
  /** Server description */
  description?: string;
  /** Server endpoint */
  endpoint: string;
  /** Transport type */
  transport: McpTransport;
  /** Auth type */
  authType?: McpAuthType;
  /** Auth configuration */
  authConfig?: {
    apiKey?: string;
    oauthClientId?: string;
    oauthClientSecret?: string;
  };
}

/**
 * Update MCP Server request DTO
 */
export interface UpdateMcpServerInput {
  /** Server name */
  name?: string;
  /** Server description */
  description?: string;
  /** Server endpoint */
  endpoint?: string;
  /** Transport type */
  transport?: McpTransport;
  /** Auth type */
  authType?: McpAuthType;
  /** Auth configuration */
  authConfig?: {
    apiKey?: string;
    oauthClientId?: string;
    oauthClientSecret?: string;
  };
  /** Whether server is active */
  isActive?: boolean;
}

// =============================================================================
// Memory DTOs
// =============================================================================

/**
 * Memory types
 */
export type MemoryTypeInput = 'episodic' | 'semantic' | 'procedural';

/**
 * Create Memory request DTO
 */
export interface CreateMemoryInput {
  /** Agent ID */
  agentId: string;
  /** Session ID */
  sessionId?: string;
  /** User ID */
  userId?: string;
  /** Memory content */
  content: string;
  /** Vector embedding */
  embedding?: number[];
  /** Memory type */
  memoryType?: MemoryTypeInput;
  /** Importance score (0-1) */
  importance?: number;
  /** Additional metadata */
  metadata?: Record<string, unknown>;
  /** Expiration timestamp */
  expiresAt?: string;
}

/**
 * Search Memories request DTO
 */
export interface SearchMemoriesInput {
  /** Agent ID */
  agentId: string;
  /** Query embedding */
  embedding: number[];
  /** Max results */
  limit?: number;
  /** Minimum similarity score */
  minSimilarity?: number;
}

// =============================================================================
// API Key DTOs
// =============================================================================

/**
 * Create API Key request DTO
 */
export interface CreateApiKeyInput {
  /** Key name */
  name: string;
  /** Permissions */
  permissions?: string[];
  /** Expiration timestamp */
  expiresAt?: string;
}

// =============================================================================
// Organization DTOs
// =============================================================================

/**
 * Update Organization request DTO
 */
export interface UpdateOrganizationInput {
  /** Organization name */
  name?: string;
  /** Organization settings */
  settings?: Record<string, unknown>;
}

// =============================================================================
// Auth DTOs
// =============================================================================

/**
 * Register request DTO
 */
export interface RegisterInput {
  /** User email */
  email: string;
  /** User password */
  password: string;
  /** User name */
  name: string;
  /** Organization name */
  orgName: string;
}

/**
 * Login request DTO
 */
export interface LoginInput {
  /** User email */
  email: string;
  /** User password */
  password: string;
}

/**
 * Refresh token request DTO
 */
export interface RefreshTokenInput {
  /** Refresh token */
  refreshToken: string;
}

// =============================================================================
// API Response Types
// =============================================================================

/**
 * Standard API response wrapper
 */
export interface ApiResponse<T> {
  /** Whether the request succeeded */
  success: boolean;
  /** Response data */
  data?: T;
  /** Error information */
  error?: {
    code: string;
    message: string;
    details?: Array<{
      field: string;
      message: string;
    }>;
  };
  /** Pagination metadata */
  meta?: PaginationMeta;
}

/**
 * Pagination metadata
 */
export interface PaginationMeta {
  /** Current page */
  page: number;
  /** Items per page */
  limit: number;
  /** Total items */
  total: number;
  /** Total pages */
  totalPages: number;
}

/**
 * Cursor pagination metadata
 */
export interface CursorPaginationMeta {
  /** Next cursor for pagination */
  nextCursor?: string;
}
