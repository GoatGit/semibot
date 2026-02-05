/**
 * Agent 服务层
 */
export interface Agent {
    id: string;
    orgId: string;
    name: string;
    description?: string;
    systemPrompt: string;
    config: AgentConfig;
    skills: string[];
    subAgents: string[];
    version: number;
    isActive: boolean;
    isPublic: boolean;
    createdAt: string;
    updatedAt: string;
}
export interface AgentConfig {
    model: string;
    temperature: number;
    maxTokens: number;
    timeoutSeconds: number;
    retryAttempts?: number;
    fallbackModel?: string;
}
export interface CreateAgentInput {
    name: string;
    description?: string;
    systemPrompt: string;
    config?: Partial<AgentConfig>;
    skills?: string[];
    subAgents?: string[];
    isPublic?: boolean;
}
export interface UpdateAgentInput {
    name?: string;
    description?: string;
    systemPrompt?: string;
    config?: Partial<AgentConfig>;
    skills?: string[];
    subAgents?: string[];
    isActive?: boolean;
    isPublic?: boolean;
}
export interface ListAgentsOptions {
    page?: number;
    limit?: number;
    isActive?: boolean;
    search?: string;
}
export interface PaginatedResult<T> {
    data: T[];
    meta: {
        total: number;
        page: number;
        limit: number;
        totalPages: number;
    };
}
/**
 * 创建 Agent
 */
export declare function createAgent(orgId: string, input: CreateAgentInput): Promise<Agent>;
/**
 * 获取 Agent
 */
export declare function getAgent(orgId: string, agentId: string): Promise<Agent>;
/**
 * 获取 Agent (允许公开访问)
 */
export declare function getAgentPublic(agentId: string): Promise<Agent>;
/**
 * 列出 Agents
 */
export declare function listAgents(orgId: string, options?: ListAgentsOptions): Promise<PaginatedResult<Agent>>;
/**
 * 更新 Agent
 */
export declare function updateAgent(orgId: string, agentId: string, input: UpdateAgentInput): Promise<Agent>;
/**
 * 删除 Agent (软删除)
 */
export declare function deleteAgent(orgId: string, agentId: string): Promise<void>;
/**
 * 验证 Agent 可用性 (用于会话创建)
 */
export declare function validateAgentForSession(orgId: string, agentId: string): Promise<Agent>;
//# sourceMappingURL=agent.service.d.ts.map