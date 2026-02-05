/**
 * Chat 服务层 - 处理对话交互和 SSE 流
 */
import type { Response } from 'express';
export type Agent2UIType = 'text' | 'markdown' | 'code' | 'table' | 'chart' | 'image' | 'file' | 'plan' | 'progress' | 'tool_call' | 'tool_result' | 'error' | 'thinking' | 'report';
export interface Agent2UIMessage {
    id: string;
    type: Agent2UIType;
    data: unknown;
    timestamp: string;
    metadata?: Record<string, unknown>;
}
export interface ChatInput {
    message: string;
    parentMessageId?: string;
}
export interface SSEConnection {
    id: string;
    res: Response;
    sessionId: string;
    userId: string;
    heartbeatTimer?: NodeJS.Timeout;
    isActive: boolean;
}
/**
 * 创建 SSE 连接
 */
export declare function createSSEConnection(res: Response, sessionId: string, userId: string): SSEConnection;
/**
 * 关闭 SSE 连接
 */
export declare function closeSSEConnection(connectionId: string): void;
/**
 * 发送 SSE 事件
 */
export declare function sendSSEEvent(connection: SSEConnection, event: string, data: unknown): boolean;
/**
 * 发送 Agent2UI 消息
 */
export declare function sendAgent2UIMessage(connection: SSEConnection, type: Agent2UIType, data: unknown, metadata?: Record<string, unknown>): boolean;
/**
 * 处理聊天消息 (SSE 流式响应)
 */
export declare function handleChat(orgId: string, userId: string, sessionId: string, input: ChatInput, res: Response): Promise<void>;
/**
 * 创建新会话并开始对话
 */
export declare function startNewChat(orgId: string, userId: string, agentId: string, input: ChatInput, res: Response): Promise<void>;
//# sourceMappingURL=chat.service.d.ts.map