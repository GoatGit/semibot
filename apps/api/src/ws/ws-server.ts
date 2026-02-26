import type { Server } from 'http'
import { createRequire } from 'module'
import crypto from 'node:crypto'
import jwt from 'jsonwebtoken'
import { v4 as uuidv4 } from 'uuid'
import fs from 'fs-extra'
import path from 'path'

import { createLogger } from '../lib/logger'
import * as sessionService from '../services/session.service'
import * as agentService from '../services/agent.service'
import * as mcpService from '../services/mcp.service'
import * as logsService from '../services/logs.service'
import * as evolvedSkillRepo from '../repositories/evolved-skill.repository'
import * as skillDefinitionRepo from '../repositories/skill-definition.repository'
import * as skillPackageRepo from '../repositories/skill-package.repository'
import { sql } from '../lib/db'
import { forwardSSE, closeSessionConnections, hasSessionConnections } from '../relay/sse-relay'
import type { VMConnection } from './vm-connection'
import { startHeartbeatMonitor } from './heartbeat'
import {
  parseJSONData,
  mapRuntimeEventToAgent2UI,
  isExecutionComplete,
  isExecutionError,
} from './message-router'
import type { VMWebSocket } from './vm-connection'
import type { Agent2UIMessage } from '@semibot/shared-types'

const wsLogger = createLogger('ws-server')
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const ALLOWED_MEMORY_TYPES = new Set(['episodic', 'semantic', 'procedural'] as const)

function normalizeSessionIdForDb(sessionId: string): string | null {
  return UUID_PATTERN.test(sessionId) ? sessionId : null
}

function normalizeMemoryType(memoryType: unknown): 'episodic' | 'semantic' | 'procedural' {
  const raw = String(memoryType ?? 'episodic').trim().toLowerCase()
  if (raw === 'long_term' || raw === 'long-term') return 'semantic'
  if (ALLOWED_MEMORY_TYPES.has(raw as 'episodic' | 'semantic' | 'procedural')) {
    return raw as 'episodic' | 'semantic' | 'procedural'
  }
  return 'episodic'
}

interface AuthPayload {
  userId: string
  orgId: string
  exp?: number
}

interface AuthContext extends AuthPayload {
  token: string
}

interface EncryptedSecretPayload {
  alg: 'aes-256-gcm'
  iv: string
  tag: string
  ciphertext: string
}

interface RuntimeProviderConfig {
  base_url: string
}

interface RuntimeLLMConfigPayload {
  default_model: string
  fallback_model: string
  providers: {
    openai: RuntimeProviderConfig
    anthropic: RuntimeProviderConfig
    google: RuntimeProviderConfig
    custom: RuntimeProviderConfig
  }
}

interface WSRequestMessage {
  type: 'request'
  id: string
  session_id: string
  method: string
  params?: Record<string, unknown>
}

interface WSSSEMessage {
  type: 'sse_event'
  session_id: string
  data: string
}

interface WSHeartbeatMessage {
  type: 'heartbeat'
  active_sessions?: string[]
}

interface WSFireAndForgetMessage {
  type: 'fire_and_forget'
  session_id: string
  method: string
  params?: Record<string, unknown>
}

interface WSResumeMessage {
  type: 'resume'
  pending_ids?: string[]
}

type WSIncomingMessage =
  | WSRequestMessage
  | WSSSEMessage
  | WSHeartbeatMessage
  | WSFireAndForgetMessage
  | WSResumeMessage
  | Record<string, unknown>

export class WSServer {
  private readonly wss: {
    on: (event: string, handler: (...args: unknown[]) => void) => void
    close: () => void
  }
  private readonly connections = new Map<string, VMConnection>()
  private readonly processBufferBySession = new Map<string, Agent2UIMessage[]>()
  private heartbeatTimer: NodeJS.Timeout

  constructor(server: Server) {
    const require = createRequire(import.meta.url)
    const { WebSocketServer } = require('ws') as { WebSocketServer: new (opts: Record<string, unknown>) => any }
    this.wss = new WebSocketServer({ server, path: '/ws/vm' })
    this.wss.on('connection', ((ws: VMWebSocket, req: { url?: string }) => this.handleConnection(ws, req.url ?? '')) as (...args: unknown[]) => void)

    this.heartbeatTimer = startHeartbeatMonitor(
      () => this.connections.values(),
      (conn) => this.handleHeartbeatTimeout(conn)
    )
  }

  getConnection(userId: string): VMConnection | undefined {
    return this.connections.get(userId)
  }

  isUserReady(userId: string): boolean {
    const conn = this.connections.get(userId)
    return Boolean(conn && conn.status === 'ready')
  }

  sendStartSession(
    userId: string,
    data: {
      session_id: string
      agent_id: string
      runtime_type: 'semigraph' | 'openclaw'
      agent_config: Record<string, unknown>
      mcp_servers: Array<Record<string, unknown>>
      skill_index: Array<Record<string, unknown>>
      sub_agents: Array<Record<string, unknown>>
      openclaw_config?: Record<string, unknown>
    }
  ): void {
    this.send(userId, { type: 'start_session', data })
    const conn = this.connections.get(userId)
    conn?.activeSessions.add(data.session_id)
  }

  sendUserMessage(userId: string, sessionId: string, data: Record<string, unknown>): void {
    this.send(userId, {
      type: 'user_message',
      session_id: sessionId,
      data,
    })
  }

  sendCancel(userId: string, sessionId: string, reason = 'user_cancelled'): void {
    this.send(userId, {
      type: 'cancel',
      session_id: sessionId,
      data: { reason },
    })
  }

  sendConfigUpdate(userId: string, sessionId: string, data: Record<string, unknown>): void {
    this.send(userId, {
      type: 'config_update',
      data: {
        session_id: sessionId,
        ...data,
      },
    })
  }

  /**
   * 广播运行时 LLM 配置更新到所有在线执行平面连接。
   * - 无 session_id: Runtime 侧会更新 init_data（影响后续新会话）
   * - 若有活跃会话，Runtime 会将更新应用到当前会话的 adapter
   */
  broadcastLLMConfigUpdate(data: { llm_config: RuntimeLLMConfigPayload; api_keys: Record<string, string> }): void {
    for (const conn of this.connections.values()) {
      if (conn.status !== 'ready') continue
      try {
        conn.ws.send(JSON.stringify({
          type: 'config_update',
          data,
        }))
      } catch (error) {
        wsLogger.warn('广播 LLM 配置到执行平面失败', {
          userId: conn.userId,
          error: (error as Error).message,
        })
      }
    }
  }

  close(): void {
    clearInterval(this.heartbeatTimer)
    for (const conn of this.connections.values()) {
      conn.ws.close()
    }
    this.connections.clear()
    this.wss.close()
  }

  private send(userId: string, payload: Record<string, unknown>): void {
    const conn = this.connections.get(userId)
    if (!conn || conn.status !== 'ready') {
      throw new Error(`用户 ${userId} 的执行平面未就绪`)
    }
    conn.ws.send(JSON.stringify(payload))
  }

  private handleConnection(ws: VMWebSocket, requestUrl: string): void {
    const params = new URL(requestUrl, 'http://localhost').searchParams
    const userId = params.get('user_id')
    const ticket = params.get('ticket') ?? undefined
    if (!userId) {
      ws.close(4001, 'user_id is required')
      return
    }

    const conn: VMConnection = {
      ws,
      userId,
      orgId: '',
      status: 'initializing',
      lastHeartbeat: Date.now(),
      activeSessions: new Set(),
      requestResults: new Map(),
    }

    ws.once('message', async (raw: unknown) => {
      const auth = await this.validateAuth(String(raw), userId, ticket)
      if (!auth) {
        ws.close(4001, 'Authentication failed')
        return
      }

      conn.orgId = auth.orgId
      conn.status = 'ready'
      this.connections.set(userId, conn)
      void this.markVMInstanceState(userId, 'ready')

      ws.send(JSON.stringify({
        type: 'init',
        data: {
          user_id: auth.userId,
          org_id: auth.orgId,
          api_keys: this.getEncryptedInitApiKeys(auth.token),
          llm_config: this.getRuntimeLLMConfig(),
        },
      }))

      ws.on('message', (message: unknown) => {
        void this.handleMessage(conn, String(message)).catch((error: unknown) => {
          wsLogger.error('处理 VM 消息失败', error as Error, {
            userId: conn.userId,
          })
        })
      })

      ws.on('close', () => {
        conn.status = 'disconnected'
        void this.markVMInstanceState(userId, 'disconnected')
        this.connections.delete(userId)
      })

      ws.on('error', (error: unknown) => {
        wsLogger.error('VM WebSocket 连接错误', error as Error, { userId })
      })
    })
  }

  private getEncryptedInitApiKeys(vmToken: string): Record<string, EncryptedSecretPayload> {
    const apiKeys: Record<string, EncryptedSecretPayload> = {}
    if (process.env.OPENAI_API_KEY) apiKeys.openai = this.encryptSecret(process.env.OPENAI_API_KEY, vmToken)
    if (process.env.ANTHROPIC_API_KEY) apiKeys.anthropic = this.encryptSecret(process.env.ANTHROPIC_API_KEY, vmToken)
    if (process.env.GOOGLE_AI_API_KEY) apiKeys.google = this.encryptSecret(process.env.GOOGLE_AI_API_KEY, vmToken)
    if (process.env.CUSTOM_LLM_API_KEY) apiKeys.custom = this.encryptSecret(process.env.CUSTOM_LLM_API_KEY, vmToken)
    return apiKeys
  }

  private getRuntimeLLMConfig(): RuntimeLLMConfigPayload {
    return {
      default_model: process.env.DEFAULT_LLM_MODEL ?? 'gpt-4o',
      fallback_model: process.env.FALLBACK_LLM_MODEL ?? 'gpt-3.5-turbo',
      providers: {
        openai: {
          base_url: process.env.OPENAI_API_BASE_URL || 'https://api.openai.com/v1',
        },
        anthropic: {
          base_url: process.env.ANTHROPIC_API_BASE_URL || 'https://api.anthropic.com/v1',
        },
        google: {
          base_url: process.env.GOOGLE_AI_API_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta',
        },
        custom: {
          base_url: process.env.CUSTOM_LLM_API_BASE_URL || '',
        },
      },
    }
  }

  private encryptSecret(secretValue: string, vmToken: string): EncryptedSecretPayload {
    const key = crypto.createHash('sha256').update(`semibot:init:${vmToken}`).digest()
    const iv = crypto.randomBytes(12)
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
    cipher.setAAD(Buffer.from('semibot:init:api_keys', 'utf-8'))
    const ciphertext = Buffer.concat([cipher.update(secretValue, 'utf-8'), cipher.final()])
    const tag = cipher.getAuthTag()
    return {
      alg: 'aes-256-gcm',
      iv: iv.toString('base64'),
      tag: tag.toString('base64'),
      ciphertext: ciphertext.toString('base64'),
    }
  }

  private async validateAuth(raw: string, expectedUserId: string, ticket?: string): Promise<AuthContext | null> {
    try {
      const payload = JSON.parse(raw) as { type?: string; token?: string }
      if (payload.type !== 'auth' || !payload.token) return null

      const secret = this.getJWTSecret()
      const decoded = jwt.verify(payload.token, secret) as AuthPayload
      if (!decoded.userId || !decoded.orgId || decoded.userId !== expectedUserId) {
        return null
      }
      if (!(await this.hasActiveVMInstance(decoded.userId))) {
        wsLogger.warn('拒绝执行平面连接：用户无活跃 VM 实例', { userId: decoded.userId })
        return null
      }
      if (!(await this.consumeOrValidateTicket(decoded.userId, ticket))) {
        wsLogger.warn('拒绝执行平面连接：ticket 校验失败', { userId: decoded.userId })
        return null
      }
      return { ...decoded, token: payload.token }
    } catch (error) {
      wsLogger.warn('执行平面 auth 校验失败', { reason: (error as Error).message })
      return null
    }
  }

  private getJWTSecret(): string {
    const secret = process.env.JWT_SECRET
    if (secret) return secret
    if ((process.env.NODE_ENV ?? 'development') === 'production') {
      throw new Error('JWT_SECRET must be configured in production')
    }
    return 'development-secret-change-in-production'
  }

  private async consumeOrValidateTicket(userId: string, ticket?: string): Promise<boolean> {
    if (process.env.NODE_ENV === 'test' || process.env.WS_SKIP_VM_TICKET_CHECK === 'true') {
      return true
    }

    if (ticket) {
      const rows = await sql<Array<{ id: string }>>`
        UPDATE user_vm_instances
        SET ticket_used_at = NOW()
        WHERE user_id = ${userId}
          AND status IN ('starting', 'provisioning', 'running', 'ready', 'disconnected')
          AND connect_ticket::text = ${ticket}
          AND ticket_used_at IS NULL
        RETURNING id
      `
      return rows.length > 0
    }

    const rows = await sql<Array<{ id: string }>>`
      SELECT id
      FROM user_vm_instances
      WHERE user_id = ${userId}
        AND status IN ('starting', 'provisioning', 'running', 'ready', 'disconnected')
        AND ticket_used_at IS NOT NULL
      ORDER BY updated_at DESC
      LIMIT 1
    `
    return rows.length > 0
  }

  private async hasActiveVMInstance(userId: string): Promise<boolean> {
    if (process.env.NODE_ENV === 'test' || process.env.WS_SKIP_VM_INSTANCE_CHECK === 'true') {
      return true
    }
    const rows = await sql<Array<{ id: string }>>`
      SELECT id
      FROM user_vm_instances
      WHERE user_id = ${userId}
        AND status IN ('starting', 'provisioning', 'running', 'ready', 'disconnected')
      ORDER BY updated_at DESC
      LIMIT 1
    `
    return rows.length > 0
  }

  private async handleMessage(conn: VMConnection, raw: string): Promise<void> {
    let msg: WSIncomingMessage
    try {
      msg = JSON.parse(raw) as WSIncomingMessage
    } catch (error) {
      wsLogger.warn('收到非法 JSON 消息，已忽略', {
        userId: conn.userId,
        error: (error as Error).message,
      })
      return
    }

    if (msg.type === 'heartbeat') {
      conn.lastHeartbeat = Date.now()
      void this.touchHeartbeat(conn.userId)
      if (Array.isArray(msg.active_sessions)) {
        conn.activeSessions = new Set(msg.active_sessions)
      }
      return
    }

    if (msg.type === 'request' && 'id' in msg && 'method' in msg && 'session_id' in msg) {
      await this.handleRequest(conn, msg as WSRequestMessage)
      return
    }

    if (msg.type === 'sse_event' && 'session_id' in msg && 'data' in msg) {
      await this.handleSSEEvent(conn, msg as WSSSEMessage)
      return
    }

    if (msg.type === 'fire_and_forget' && 'session_id' in msg && 'method' in msg) {
      await this.handleFireAndForget(conn, msg as WSFireAndForgetMessage)
      return
    }

    if (msg.type === 'resume') {
      this.handleResume(conn, msg as WSResumeMessage)
      return
    }
  }

  private async handleRequest(conn: VMConnection, msg: WSRequestMessage): Promise<void> {
    const response: Record<string, unknown> = {
      type: 'response',
      id: msg.id,
      result: null,
      error: null,
    }

    try {
      switch (msg.method) {
        case 'get_session': {
          const sessionId = (msg.params?.session_id as string) || msg.session_id
          const session = await sessionService.getSession(conn.orgId, sessionId)
          const agent = await agentService.getAgent(conn.orgId, session.agentId)
          response.result = { session, agent }
          break
        }

        case 'get_config': {
          const agentId = msg.params?.agent_id as string
          response.result = await agentService.getAgent(conn.orgId, agentId)
          break
        }

        case 'mcp_call': {
          const server = msg.params?.server as string
          const tool = msg.params?.tool as string
          const argumentsValue = (msg.params?.arguments as Record<string, unknown>) ?? {}
          response.result = await mcpService.callMcpTool(server, conn.orgId, tool, argumentsValue)
          break
        }

        case 'memory_search': {
          const query = String(msg.params?.query ?? '').trim()
          const topK = Number(msg.params?.top_k ?? 5)
          const limit = Math.max(1, Math.min(topK, 20))
          if (!query) {
            response.result = { results: [] }
            break
          }
          const queryEmbedding = await this.generateOpenAIEmbedding(query)
          const rows = queryEmbedding
            ? await sql<Array<{ content: string; score: number; metadata: Record<string, unknown> | null; created_at: string }>>`
                SELECT content,
                       (1 - (embedding <=> ${JSON.stringify(queryEmbedding)}::vector))::FLOAT AS score,
                       metadata,
                       created_at
                FROM memories
                WHERE org_id = ${conn.orgId}
                  AND (expires_at IS NULL OR expires_at > NOW())
                  AND embedding IS NOT NULL
                ORDER BY embedding <=> ${JSON.stringify(queryEmbedding)}::vector
                LIMIT ${limit}
              `
            : await sql<Array<{ content: string; score: number; metadata: Record<string, unknown> | null; created_at: string }>>`
                SELECT content,
                       GREATEST(
                         0.01,
                         1 - (
                           (POSITION(LOWER(${query}) IN LOWER(content)) - 1)::FLOAT
                           / GREATEST(LENGTH(content), 1)
                         )
                       ) AS score,
                       metadata,
                       created_at
                FROM memories
                WHERE org_id = ${conn.orgId}
                  AND (expires_at IS NULL OR expires_at > NOW())
                  AND content ILIKE ${`%${query}%`}
                ORDER BY score DESC, importance DESC, created_at DESC
                LIMIT ${limit}
              `
          response.result = {
            results: rows.map((r) => ({
              content: r.content,
              score: Number(r.score ?? 0),
              metadata: r.metadata ?? { created_at: r.created_at },
            })),
          }
          break
        }

        case 'get_skill_package': {
          const skillId = String(msg.params?.skill_id ?? '')
          response.result = await this.loadSkillPackage(skillId)
          break
        }

        default:
          response.error = { code: 'UNSUPPORTED_METHOD', message: `不支持的方法: ${msg.method}` }
      }
    } catch (error) {
      response.error = {
        code: 'REQUEST_FAILED',
        message: (error as Error).message,
      }
    }

    this.cacheRequestResult(conn, msg.id, response)
    conn.ws.send(JSON.stringify(response))
  }

  private async generateOpenAIEmbedding(query: string): Promise<number[] | null> {
    const apiKey = process.env.OPENAI_API_KEY
    if (!apiKey) return null
    const base = process.env.OPENAI_API_BASE_URL || 'https://api.openai.com/v1'
    const model = process.env.OPENAI_EMBEDDING_MODEL || 'text-embedding-3-small'
    try {
      const response = await fetch(`${base}/embeddings`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          input: query,
        }),
      })
      if (!response.ok) {
        wsLogger.warn('OpenAI embedding 调用失败，降级为文本匹配', {
          status: response.status,
          statusText: response.statusText,
        })
        return null
      }
      const data = await response.json() as { data?: Array<{ embedding?: number[] }> }
      const embedding = data.data?.[0]?.embedding
      if (!Array.isArray(embedding) || embedding.length === 0) {
        return null
      }
      return embedding
    } catch (error) {
      wsLogger.warn('OpenAI embedding 调用异常，降级为文本匹配', {
        error: (error as Error).message,
      })
      return null
    }
  }

  private cacheRequestResult(conn: VMConnection, requestId: string, response: Record<string, unknown>): void {
    const errorValue = response.error as { code?: string; message?: string } | null
    if (errorValue) {
      conn.requestResults.set(requestId, {
        status: 'failed',
        error: {
          code: String(errorValue.code ?? 'REQUEST_FAILED'),
          message: String(errorValue.message ?? 'Request failed'),
        },
        updatedAt: Date.now(),
      })
    } else {
      conn.requestResults.set(requestId, {
        status: 'completed',
        data: response.result,
        updatedAt: Date.now(),
      })
    }

    if (conn.requestResults.size > 200) {
      const oldest = [...conn.requestResults.entries()].sort((a, b) => a[1].updatedAt - b[1].updatedAt).slice(0, 50)
      for (const [key] of oldest) conn.requestResults.delete(key)
    }
  }

  private handleResume(conn: VMConnection, msg: WSResumeMessage): void {
    const pendingIds = Array.isArray(msg.pending_ids) ? msg.pending_ids : []
    const results: Record<string, Record<string, unknown>> = {}
    for (const id of pendingIds) {
      const cached = conn.requestResults.get(id)
      if (!cached) {
        results[id] = { status: 'lost' }
        continue
      }
      if (cached.status === 'completed') {
        results[id] = { status: 'completed', data: cached.data ?? null }
      } else {
        results[id] = { status: 'failed', error: cached.error ?? null }
      }
    }

    conn.ws.send(
      JSON.stringify({
        type: 'resume_response',
        results,
      })
    )
  }

  private async handleSSEEvent(conn: VMConnection, msg: WSSSEMessage): Promise<void> {
    const parsed = parseJSONData(msg.data)
    if (!parsed) {
      wsLogger.warn('收到无法解析的 sse_event', { userId: conn.userId, sessionId: msg.session_id })
      return
    }

    if (isExecutionError(parsed)) {
      this.processBufferBySession.delete(msg.session_id)
      forwardSSE(msg.session_id, 'error', {
        code: (parsed.code as string) ?? 'SSE_STREAM_ERROR',
        message: (parsed.error as string) ?? '执行失败',
      })
      closeSessionConnections(msg.session_id)
      return
    }

    if (isExecutionComplete(parsed)) {
      const finalResponse = (parsed.final_response as string) ?? (parsed.content as string) ?? ''
      const processMessages = this.processBufferBySession.get(msg.session_id) ?? []
      this.processBufferBySession.delete(msg.session_id)
      let messageId = uuidv4()
      if (finalResponse) {
        try {
          const saved = await sessionService.addMessage(conn.orgId, msg.session_id, {
            role: 'assistant',
            content: finalResponse,
            metadata: processMessages.length > 0
              ? {
                  execution_process: {
                    version: 1,
                    messages: processMessages,
                  },
                }
              : undefined,
          })
          messageId = saved.id
        } catch (error) {
          wsLogger.error('execution_complete 落库失败', error as Error, {
            sessionId: msg.session_id,
            userId: conn.userId,
            finalResponseLength: finalResponse.length,
          })
        }
      }

      forwardSSE(msg.session_id, 'execution_complete', {
        sessionId: msg.session_id,
        messageId,
      })
      closeSessionConnections(msg.session_id)
      return
    }

    const agentMessage = mapRuntimeEventToAgent2UI(parsed)
    if (!agentMessage) {
      return
    }

    if (this.shouldBufferProcessMessage(agentMessage.type)) {
      const current = this.processBufferBySession.get(msg.session_id) ?? []
      current.push(agentMessage)
      // Guard memory growth for long-running sessions.
      if (current.length > 500) {
        current.splice(0, current.length - 500)
      }
      this.processBufferBySession.set(msg.session_id, current)
    }

    // Persist durable file events so refresh can restore download cards.
    if (agentMessage.type === 'file') {
      await sessionService.addMessage(conn.orgId, msg.session_id, {
        role: 'assistant',
        content: '',
        metadata: {
          agent2ui: agentMessage,
        },
      })
    }

    forwardSSE(msg.session_id, 'message', agentMessage)
  }

  private shouldBufferProcessMessage(type: string): boolean {
    return (
      type === 'thinking' ||
      type === 'plan' ||
      type === 'plan_step' ||
      type === 'tool_call' ||
      type === 'tool_result' ||
      type === 'mcp_call' ||
      type === 'mcp_result'
    )
  }

  private async handleFireAndForget(conn: VMConnection, msg: WSFireAndForgetMessage): Promise<void> {
    const sessionId = msg.session_id
    const params = msg.params ?? {}

    try {
      switch (msg.method) {
        case 'usage_report': {
          const now = new Date()
          const periodStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString()
          const periodEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).toISOString()

          await logsService.recordUsage(conn.orgId, 'daily', periodStart, periodEnd, {
            userId: conn.userId,
            tokensInput: Number(params.tokens_in ?? 0),
            tokensOutput: Number(params.tokens_out ?? 0),
            apiCalls: 1,
            sessionsCount: 1,
            messagesCount: 1,
            costUsd: 0,
          })
          break
        }

        case 'audit_log': {
          const session = await sessionService.getSession(conn.orgId, sessionId)
          await logsService.logExecution(conn.orgId, {
            agentId: session.agentId,
            sessionId,
            state: String(params.event ?? 'runtime_event'),
            actionType: 'ws_fire_and_forget',
            actionName: 'audit_log',
            actionInput: (params.details as Record<string, unknown>) ?? {},
            metadata: {
              source: 'execution_plane',
              userId: conn.userId,
            },
          })
          break
        }

        case 'snapshot_sync': {
          await sql`
            INSERT INTO session_snapshots (
              session_id,
              user_id,
              org_id,
              checkpoint,
              short_term_memory,
              conversation_state,
              file_manifest
            )
            VALUES (
              ${sessionId},
              ${conn.userId},
              ${conn.orgId},
              ${sql.json(((params.checkpoint as Record<string, unknown>) ?? {}) as Parameters<typeof sql.json>[0])},
              ${sql.json(((params.short_term_memory as Record<string, unknown>) ?? {}) as Parameters<typeof sql.json>[0])},
              ${sql.json(((params.conversation_state as Record<string, unknown>) ?? {}) as Parameters<typeof sql.json>[0])},
              ${sql.json(((params.file_manifest as Record<string, unknown>) ?? {}) as Parameters<typeof sql.json>[0])}
            )
          `
          await sql`
            DELETE FROM session_snapshots
            WHERE session_id = ${sessionId}
              AND id NOT IN (
                SELECT id
                FROM session_snapshots
                WHERE session_id = ${sessionId}
                ORDER BY created_at DESC
                LIMIT 3
              )
          `
          break
        }

        case 'memory_write': {
          const agentId = String(params.agent_id ?? '')
          const content = String(params.content ?? '')
          if (!agentId || !content.trim()) {
            break
          }
          const normalizedSessionId = normalizeSessionIdForDb(sessionId)
          const normalizedMemoryType = normalizeMemoryType(params.memory_type)
          const baseMetadata = ((params.metadata as Record<string, unknown>) ?? {})
          const metadata =
            normalizedSessionId === null
              ? { ...baseMetadata, runtime_session_id: sessionId }
              : baseMetadata
          const embedding = await this.generateOpenAIEmbedding(content.trim())
          await sql`
            INSERT INTO memories (
              org_id, agent_id, session_id, user_id, content, embedding, memory_type, importance, metadata, expires_at
            )
            VALUES (
              ${conn.orgId},
              ${agentId},
              ${normalizedSessionId},
              ${conn.userId},
              ${content},
              ${embedding ? JSON.stringify(embedding) : null}::vector,
              ${normalizedMemoryType},
              ${Number(params.importance ?? 0.5)},
              ${sql.json(metadata as Parameters<typeof sql.json>[0])},
              NULL
            )
          `
          break
        }

        case 'evolution_submit': {
          const session = await sessionService.getSession(conn.orgId, sessionId)
          const qualityScore = Number(params.quality_score ?? 0.5)
          await evolvedSkillRepo.create({
            orgId: conn.orgId,
            agentId: session.agentId,
            sessionId,
            name: String(params.name ?? 'evolved-skill'),
            description: String(params.description ?? 'Generated by execution plane'),
            triggerKeywords: [],
            steps: [],
            toolsUsed: [],
            parameters: {
              skill_md: String(params.skill_md ?? ''),
            },
            preconditions: {},
            expectedOutcome: '',
            qualityScore,
            reusabilityScore: qualityScore,
            status: qualityScore >= 0.8 ? 'approved' : 'pending_review',
          })
          break
        }

        default:
          wsLogger.warn('未知 fire_and_forget 方法', { method: msg.method, sessionId })
      }
    } catch (error) {
      wsLogger.error('处理 fire_and_forget 失败', error as Error, {
        method: msg.method,
        sessionId,
        userId: conn.userId,
      })
    }
  }

  private async loadSkillPackage(skillId: string): Promise<Record<string, unknown>> {
    if (!skillId) {
      return { package: null }
    }

    const skillDef = await skillDefinitionRepo.findBySkillId(skillId)
    if (!skillDef) {
      return { package: null }
    }

    const skillPkg = await skillPackageRepo.findByDefinition(skillDef.id)
    if (!skillPkg || !skillPkg.packagePath) {
      return { package: null }
    }

    const packagePath = path.resolve(skillPkg.packagePath)
    const exists = await fs.pathExists(packagePath)
    if (!exists) {
      return { package: null }
    }

    const files = await this.collectSkillFiles(packagePath)
    const fileInventory = {
      has_skill_md: files.some((f) => f.path === 'SKILL.md'),
      has_scripts: files.some((f) => f.path.startsWith('scripts/')),
      has_references: files.some((f) => f.path.startsWith('references/')),
      script_files: files.filter((f) => f.path.startsWith('scripts/')).map((f) => f.path),
      reference_files: files.filter((f) => f.path.startsWith('references/')).map((f) => f.path),
    }

    return {
      package: {
        skill_id: skillId,
        version: 'current',
        files,
        file_inventory: fileInventory,
      },
    }
  }

  private async collectSkillFiles(baseDir: string): Promise<Array<{ path: string; content: string; encoding: string }>> {
    const relPaths: string[] = []

    const tryPush = async (rel: string): Promise<void> => {
      const full = path.join(baseDir, rel)
      if (await fs.pathExists(full)) {
        relPaths.push(rel)
      }
    }

    await tryPush('SKILL.md')
    await tryPush('REFERENCE.md')
    await tryPush('manifest.json')

    const scanDir = async (subdir: string, maxFiles: number): Promise<void> => {
      const dir = path.join(baseDir, subdir)
      if (!(await fs.pathExists(dir))) return
      const entries = await fs.readdir(dir, { withFileTypes: true })
      let count = 0
      for (const e of entries) {
        if (count >= maxFiles) break
        if (!e.isFile()) continue
        relPaths.push(path.posix.join(subdir, e.name))
        count += 1
      }
    }

    await scanDir('scripts', 20)
    await scanDir('references', 20)

    const files: Array<{ path: string; content: string; encoding: string }> = []
    for (const rel of relPaths) {
      const full = path.join(baseDir, rel)
      const content = await fs.readFile(full, 'utf-8')
      files.push({ path: rel, content, encoding: 'utf-8' })
    }
    return files
  }

  private handleHeartbeatTimeout(conn: VMConnection): void {
    wsLogger.warn('执行平面心跳超时', { userId: conn.userId })
    conn.status = 'disconnected'
    conn.ws.close(4008, 'Heartbeat timeout')
    void this.markVMInstanceState(conn.userId, 'disconnected')

    for (const sessionId of conn.activeSessions) {
      if (hasSessionConnections(sessionId)) {
        forwardSSE(sessionId, 'error', {
          code: 'EXECUTION_PLANE_DISCONNECTED',
          message: '执行平面连接已断开',
        })
        closeSessionConnections(sessionId)
      }
    }

    this.connections.delete(conn.userId)
  }

  private async markVMInstanceState(userId: string, status: 'ready' | 'disconnected'): Promise<void> {
    try {
      await sql`
        UPDATE user_vm_instances
        SET status = ${status},
            last_heartbeat_at = NOW(),
            disconnected_at = ${status === 'disconnected' ? sql`NOW()` : null},
            updated_at = NOW()
        WHERE user_id = ${userId}
          AND status IN ('starting', 'provisioning', 'running', 'ready', 'disconnected')
      `
    } catch (error) {
      wsLogger.warn('更新 VM 实例状态失败', { userId, status, error: (error as Error).message })
    }
  }

  private async touchHeartbeat(userId: string): Promise<void> {
    try {
      await sql`
        UPDATE user_vm_instances
        SET last_heartbeat_at = NOW(),
            updated_at = NOW()
        WHERE user_id = ${userId}
          AND status IN ('starting', 'provisioning', 'running', 'ready')
      `
    } catch (error) {
      wsLogger.warn('更新 VM 心跳失败', { userId, error: (error as Error).message })
    }
  }
}

let wsServerInstance: WSServer | null = null

export function initWSServer(server: Server): WSServer {
  if (!wsServerInstance) {
    wsServerInstance = new WSServer(server)
  }
  return wsServerInstance
}

export function getWSServer(): WSServer {
  if (!wsServerInstance) {
    throw new Error('WSServer 尚未初始化')
  }
  return wsServerInstance
}
