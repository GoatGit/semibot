/**
 * Agent 服务层
 */
import { v4 as uuidv4 } from 'uuid';
import { createError } from '../middleware/errorHandler.js';
import { AGENT_NOT_FOUND, AGENT_INACTIVE, AGENT_LIMIT_EXCEEDED, } from '../constants/errorCodes.js';
import { MAX_PAGE_SIZE, DEFAULT_PAGE_SIZE } from '../constants/config.js';
// ═══════════════════════════════════════════════════════════════
// 模拟数据存储 (开发用，生产环境使用数据库)
// ═══════════════════════════════════════════════════════════════
const agentsStore = new Map();
// ═══════════════════════════════════════════════════════════════
// 默认配置
// ═══════════════════════════════════════════════════════════════
const DEFAULT_AGENT_CONFIG = {
    model: 'gpt-4o',
    temperature: 0.7,
    maxTokens: 4096,
    timeoutSeconds: 120,
    retryAttempts: 3,
    fallbackModel: 'gpt-4o-mini',
};
// ═══════════════════════════════════════════════════════════════
// 服务方法
// ═══════════════════════════════════════════════════════════════
/**
 * 创建 Agent
 */
export async function createAgent(orgId, input) {
    // 检查配额 (模拟)
    const orgAgents = Array.from(agentsStore.values()).filter((a) => a.orgId === orgId);
    const maxAgents = 100; // 从组织配额获取
    if (orgAgents.length >= maxAgents) {
        console.warn(`[AgentService] Agent 数量已达上限 - 组织: ${orgId}, 当前: ${orgAgents.length}, 限制: ${maxAgents}`);
        throw createError(AGENT_LIMIT_EXCEEDED);
    }
    const now = new Date().toISOString();
    const agent = {
        id: uuidv4(),
        orgId,
        name: input.name,
        description: input.description,
        systemPrompt: input.systemPrompt,
        config: { ...DEFAULT_AGENT_CONFIG, ...input.config },
        skills: input.skills ?? [],
        subAgents: input.subAgents ?? [],
        version: 1,
        isActive: true,
        isPublic: input.isPublic ?? false,
        createdAt: now,
        updatedAt: now,
    };
    agentsStore.set(agent.id, agent);
    return agent;
}
/**
 * 获取 Agent
 */
export async function getAgent(orgId, agentId) {
    const agent = agentsStore.get(agentId);
    if (!agent || agent.orgId !== orgId) {
        throw createError(AGENT_NOT_FOUND);
    }
    return agent;
}
/**
 * 获取 Agent (允许公开访问)
 */
export async function getAgentPublic(agentId) {
    const agent = agentsStore.get(agentId);
    if (!agent) {
        throw createError(AGENT_NOT_FOUND);
    }
    if (!agent.isPublic && !agent.isActive) {
        throw createError(AGENT_NOT_FOUND);
    }
    return agent;
}
/**
 * 列出 Agents
 */
export async function listAgents(orgId, options = {}) {
    const { page = 1, limit = DEFAULT_PAGE_SIZE, isActive, search, } = options;
    // 限制分页大小
    const actualLimit = Math.min(limit, MAX_PAGE_SIZE);
    if (limit > MAX_PAGE_SIZE) {
        console.warn(`[AgentService] 分页大小超出限制，已截断 - 请求: ${limit}, 限制: ${MAX_PAGE_SIZE}`);
    }
    let agents = Array.from(agentsStore.values()).filter((a) => a.orgId === orgId);
    // 筛选活跃状态
    if (isActive !== undefined) {
        agents = agents.filter((a) => a.isActive === isActive);
    }
    // 搜索
    if (search) {
        const searchLower = search.toLowerCase();
        agents = agents.filter((a) => a.name.toLowerCase().includes(searchLower) ||
            a.description?.toLowerCase().includes(searchLower));
    }
    // 排序 (按更新时间倒序)
    agents.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
    // 分页
    const total = agents.length;
    const totalPages = Math.ceil(total / actualLimit);
    const offset = (page - 1) * actualLimit;
    const data = agents.slice(offset, offset + actualLimit);
    return {
        data,
        meta: {
            total,
            page,
            limit: actualLimit,
            totalPages,
        },
    };
}
/**
 * 更新 Agent
 */
export async function updateAgent(orgId, agentId, input) {
    const agent = await getAgent(orgId, agentId);
    const updatedAgent = {
        ...agent,
        ...(input.name !== undefined && { name: input.name }),
        ...(input.description !== undefined && { description: input.description }),
        ...(input.systemPrompt !== undefined && { systemPrompt: input.systemPrompt }),
        ...(input.config !== undefined && { config: { ...agent.config, ...input.config } }),
        ...(input.skills !== undefined && { skills: input.skills }),
        ...(input.subAgents !== undefined && { subAgents: input.subAgents }),
        ...(input.isActive !== undefined && { isActive: input.isActive }),
        ...(input.isPublic !== undefined && { isPublic: input.isPublic }),
        version: agent.version + 1,
        updatedAt: new Date().toISOString(),
    };
    agentsStore.set(agentId, updatedAgent);
    return updatedAgent;
}
/**
 * 删除 Agent (软删除)
 */
export async function deleteAgent(orgId, agentId) {
    const agent = await getAgent(orgId, agentId);
    // 软删除 - 标记为不活跃
    agentsStore.set(agentId, {
        ...agent,
        isActive: false,
        updatedAt: new Date().toISOString(),
    });
}
/**
 * 验证 Agent 可用性 (用于会话创建)
 */
export async function validateAgentForSession(orgId, agentId) {
    const agent = await getAgent(orgId, agentId);
    if (!agent.isActive) {
        throw createError(AGENT_INACTIVE);
    }
    return agent;
}
//# sourceMappingURL=agent.service.js.map