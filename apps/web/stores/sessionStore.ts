import { create } from 'zustand'

/**
 * Session Store - 会话状态管理
 */

export interface MessageAttachment {
  filename: string
  mimeType: string
  size: number
  isImage: boolean
}

export interface Message {
  id: string
  sessionId: string
  role: 'user' | 'assistant' | 'system' | 'tool'
  content: string
  toolCalls?: ToolCall[]
  toolCallId?: string
  metadata?: { attachments?: MessageAttachment[] }
  createdAt: string
}

export interface ToolCall {
  id: string
  type: 'function'
  function: {
    name: string
    arguments: string
  }
}

export interface Session {
  id: string
  agentId: string
  title: string
  status: 'active' | 'paused' | 'completed' | 'failed'
  messages: Message[]
  createdAt: string
  updatedAt: string
}

export interface ExecutionStep {
  id: string
  title: string
  status: 'pending' | 'running' | 'completed' | 'failed'
  substeps?: ExecutionStep[]
}

export interface ToolCallStatus {
  id: string
  toolName: string
  arguments: Record<string, unknown>
  status: 'calling' | 'success' | 'error'
  result?: unknown
  duration?: number
  error?: string
}

interface SessionState {
  // 当前会话
  currentSession: Session | null
  sessions: Session[]

  // 执行状态
  executionSteps: ExecutionStep[]
  toolCalls: ToolCallStatus[]
  isThinking: boolean
  thinkingContent: string

  // 动作
  setCurrentSession: (session: Session | null) => void
  addSession: (session: Session) => void
  updateSession: (sessionId: string, updates: Partial<Session>) => void
  removeSession: (sessionId: string) => void

  addMessage: (message: Message) => void
  updateMessage: (messageId: string, updates: Partial<Message>) => void

  setExecutionSteps: (steps: ExecutionStep[]) => void
  updateExecutionStep: (stepId: string, updates: Partial<ExecutionStep>) => void

  addToolCall: (toolCall: ToolCallStatus) => void
  updateToolCall: (toolCallId: string, updates: Partial<ToolCallStatus>) => void

  setIsThinking: (isThinking: boolean) => void
  setThinkingContent: (content: string) => void

  clearSession: () => void
}

export const useSessionStore = create<SessionState>((set) => ({
  // 初始状态
  currentSession: null,
  sessions: [],
  executionSteps: [],
  toolCalls: [],
  isThinking: false,
  thinkingContent: '',

  // 会话管理
  setCurrentSession: (session) =>
    set({
      currentSession: session,
    }),

  addSession: (session) =>
    set((state) => ({
      sessions: [session, ...state.sessions],
    })),

  updateSession: (sessionId, updates) =>
    set((state) => ({
      sessions: state.sessions.map((s) =>
        s.id === sessionId ? { ...s, ...updates } : s
      ),
      currentSession:
        state.currentSession?.id === sessionId
          ? { ...state.currentSession, ...updates }
          : state.currentSession,
    })),

  removeSession: (sessionId) =>
    set((state) => ({
      sessions: state.sessions.filter((s) => s.id !== sessionId),
      currentSession:
        state.currentSession?.id === sessionId ? null : state.currentSession,
    })),

  // 消息管理
  addMessage: (message) =>
    set((state) => {
      if (!state.currentSession) return state

      return {
        currentSession: {
          ...state.currentSession,
          messages: [...state.currentSession.messages, message],
        },
      }
    }),

  updateMessage: (messageId, updates) =>
    set((state) => {
      if (!state.currentSession) return state

      return {
        currentSession: {
          ...state.currentSession,
          messages: state.currentSession.messages.map((m) =>
            m.id === messageId ? { ...m, ...updates } : m
          ),
        },
      }
    }),

  // 执行步骤管理
  setExecutionSteps: (steps) =>
    set({
      executionSteps: steps,
    }),

  updateExecutionStep: (stepId, updates) =>
    set((state) => ({
      executionSteps: state.executionSteps.map((s) =>
        s.id === stepId ? { ...s, ...updates } : s
      ),
    })),

  // 工具调用管理
  addToolCall: (toolCall) =>
    set((state) => ({
      toolCalls: [...state.toolCalls, toolCall],
    })),

  updateToolCall: (toolCallId, updates) =>
    set((state) => ({
      toolCalls: state.toolCalls.map((t) =>
        t.id === toolCallId ? { ...t, ...updates } : t
      ),
    })),

  // 思考状态
  setIsThinking: (isThinking) =>
    set({
      isThinking,
    }),

  setThinkingContent: (content) =>
    set({
      thinkingContent: content,
    }),

  // 清理
  clearSession: () =>
    set({
      currentSession: null,
      executionSteps: [],
      toolCalls: [],
      isThinking: false,
      thinkingContent: '',
    }),
}))
