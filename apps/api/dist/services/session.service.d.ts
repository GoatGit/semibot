/**
 * Session 服务层
 */
export type SessionStatus = 'active' | 'paused' | 'completed' | 'failed';
export type MessageRole = 'system' | 'user' | 'assistant' | 'tool';
export interface Session {
    id: string;
    orgId: string;
    agentId: string;
    userId: string;
    status: SessionStatus;
    title?: string;
    metadata?: Record<string, unknown>;
    startedAt: string;
    endedAt?: string;
    createdAt: string;
}
export interface Message {
    id: string;
    sessionId: string;
    parentId?: string;
    role: MessageRole;
    content: string;
    toolCalls?: ToolCall[];
    toolCallId?: string;
    tokensUsed?: number;
    latencyMs?: number;
    metadata?: Record<string, unknown>;
    createdAt: string;
}
export interface ToolCall {
    id: string;
    type: 'function';
    function: {
        name: string;
        arguments: string;
    };
}
export interface CreateSessionInput {
    agentId: string;
    title?: string;
    metadata?: Record<string, unknown>;
}
export interface AddMessageInput {
    role: MessageRole;
    content: string;
    parentId?: string;
    toolCalls?: ToolCall[];
    toolCallId?: string;
    tokensUsed?: number;
    latencyMs?: number;
    metadata?: Record<string, unknown>;
}
export interface ListSessionsOptions {
    page?: number;
    limit?: number;
    agentId?: string;
    status?: SessionStatus;
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
 * 创建会话
 */
export declare function createSession(orgId: string, userId: string, input: CreateSessionInput): Promise<Session>;
/**
 * 获取会话
 */
export declare function getSession(orgId: string, sessionId: string): Promise<Session>;
/**
 * 列出会话
 */
export declare function listSessions(orgId: string, userId: string, options?: ListSessionsOptions): Promise<PaginatedResult<Session>>;
/**
 * 更新会话状态
 */
export declare function updateSessionStatus(orgId: string, sessionId: string, status: SessionStatus): Promise<Session>;
/**
 * 更新会话标题
 */
export declare function updateSessionTitle(orgId: string, sessionId: string, title: string): Promise<Session>;
/**
 * 删除会话
 */
export declare function deleteSession(orgId: string, sessionId: string): Promise<void>;
/**
 * 获取会话消息列表
 */
export declare function getSessionMessages(orgId: string, sessionId: string): Promise<Message[]>;
/**
 * 添加消息到会话
 */
export declare function addMessage(orgId: string, sessionId: string, input: AddMessageInput): Promise<Message>;
/**
 * 更新消息
 */
export declare function updateMessage(orgId: string, sessionId: string, messageId: string, updates: Partial<Pick<Message, 'content' | 'tokensUsed' | 'latencyMs' | 'metadata'>>): Promise<Message>;
//# sourceMappingURL=session.service.d.ts.map