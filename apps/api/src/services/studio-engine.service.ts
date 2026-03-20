/**
 * Studio Engine — DAG 执行引擎
 *
 * 完全运行在控制平面（apps/api），不改动执行平面（runtime）。
 * 通过现有 Chat API 启动 Agent session，从 messages 表读取输出。
 */

import { createLogger } from '../lib/logger'
import * as studioRepo from '../repositories/studio.repository'
import * as agentService from './agent.service'
import * as sessionService from './session.service'
import type { AgentNode, StudioEdge, NodeOutput } from '@semibot/shared-types'

const logger = createLogger('studio-engine')

const POLL_INTERVAL_MS = 2000
const MAX_WAIT_MS = 30 * 60 * 1000
const STUDIO_USER_ID = 'studio-engine'

// ─── 拓扑分层算法 ─────────────────────────────────────────────

function topologicalLayers(nodes: AgentNode[], edges: StudioEdge[]): AgentNode[][] {
  const inDegree = new Map<string, number>()
  const adj = new Map<string, string[]>()
  for (const n of nodes) {
    inDegree.set(n.id, 0)
    adj.set(n.id, [])
  }
  for (const e of edges) {
    inDegree.set(e.target, (inDegree.get(e.target) ?? 0) + 1)
    adj.get(e.source)?.push(e.target)
  }

  const layers: AgentNode[][] = []
  let queue = nodes.filter((n) => (inDegree.get(n.id) ?? 0) === 0)

  while (queue.length > 0) {
    layers.push(queue)
    const next: AgentNode[] = []
    for (const n of queue) {
      for (const targetId of adj.get(n.id) ?? []) {
        const deg = (inDegree.get(targetId) ?? 1) - 1
        inDegree.set(targetId, deg)
        if (deg === 0) {
          const targetNode = nodes.find((x) => x.id === targetId)
          if (targetNode) next.push(targetNode)
        }
      }
    }
    queue = next
  }
  return layers
}

// ─── Runtime 调用 ─────────────────────────────────────────────

function getRuntimeBaseUrl(): string {
  const configured = (process.env.RUNTIME_URL || '').trim().replace(/\/+$/, '')
  if (configured) return configured
  const port = String(process.env.RUNTIME_PORT || '8765').trim() || '8765'
  return `http://127.0.0.1:${port}`
}

async function sendMessageToRuntime(
  sessionId: string,
  message: string,
  agent: Awaited<ReturnType<typeof agentService.getAgent>>
): Promise<void> {
  const baseUrl = getRuntimeBaseUrl()
  const n = new Date()
  const dateStr = `${n.getFullYear()}年${n.getMonth() + 1}月${n.getDate()}日`
  const systemPrompt = `${agent.systemPrompt || `你是 ${agent.name}，一个有帮助的 AI 助手。`}\n\n当前日期: ${dateStr}`

  const response = await fetch(`${baseUrl}/api/v1/chat/sessions/${sessionId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message,
      agent_id: agent.id,
      model: agent.config?.model,
      model_provider_key: (agent.config as unknown as Record<string, unknown>)?.modelProviderKey,
      fallback_model: agent.config?.fallbackModel,
      system_prompt: systemPrompt,
      skill_index: [],
      stream: true,
    }),
  })

  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new Error(`Runtime 调用失败: HTTP ${response.status} ${body.slice(0, 200)}`)
  }

  // 消费流（不处理内容，只等待完成）
  if (response.body) {
    const reader = response.body.getReader()
    try {
      while (true) {
        const { done } = await reader.read()
        if (done) break
      }
    } finally {
      reader.releaseLock()
    }
  }
}

// ─── 等待 Session 完成 ────────────────────────────────────────

async function waitForCompletion(
  sessionId: string,
  runId: string
): Promise<'completed' | 'failed'> {
  const deadline = Date.now() + MAX_WAIT_MS
  while (Date.now() < deadline) {
    const run = await studioRepo.findRunById(runId)
    if (run?.status === 'cancelled') throw new Error('run cancelled')

    try {
      const session = await sessionService.getSession(sessionId)
      if (session.status === 'completed') return 'completed'
      if (session.status === 'failed') return 'failed'
    } catch {
      // session 可能还未写入，继续等待
    }

    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
  }
  throw new Error(`session ${sessionId} 超时（30分钟）`)
}

// ─── 收集节点输出 ─────────────────────────────────────────────

async function collectNodeOutput(sessionId: string): Promise<NodeOutput> {
  const messages = await sessionService.getSessionMessages(sessionId)
  const assistantMsgs = messages.filter((m) => m.role === 'assistant')

  const text = assistantMsgs
    .filter((m) => !m.metadata?.type || m.metadata.type === 'text')
    .map((m) => m.content)
    .join('\n\n')

  const files: NodeOutput['files'] = assistantMsgs
    .filter((m) => m.metadata?.type === 'file')
    .map((m) => ({
      url: String(m.metadata?.url ?? ''),
      filename: String(m.metadata?.filename ?? ''),
      mimeType: String(m.metadata?.mimeType ?? ''),
    }))

  return { text, files }
}

// ─── 构造下游消息 ─────────────────────────────────────────────

function buildUserMessage(
  upstreamOutputs: { nodeName: string; output: NodeOutput }[],
  initialInputs: Record<string, unknown>
): string {
  const parts: string[] = []

  if (Object.keys(initialInputs).length > 0) {
    parts.push(`## 初始输入\n${JSON.stringify(initialInputs, null, 2)}`)
  }

  for (const { nodeName, output } of upstreamOutputs) {
    const section = [`## 来自「${nodeName}」的输出`]
    if (output.text) section.push(output.text)
    for (const f of output.files) {
      section.push(`文件：${f.filename}（${f.url}）`)
    }
    parts.push(section.join('\n'))
  }

  return parts.join('\n\n---\n\n')
}

// ─── 执行单个节点 ─────────────────────────────────────────────

async function executeNode(
  runId: string,
  node: AgentNode,
  nodes: AgentNode[],
  edges: StudioEdge[],
  inputs: Record<string, unknown>
): Promise<void> {
  await studioRepo.updateRunCurrentNode(runId, node.id)
  await studioRepo.saveNodeResult(runId, node.id, {
    status: 'running',
    startedAt: new Date().toISOString(),
  })

  const run = await studioRepo.findRunById(runId)
  if (!run) throw new Error(`run ${runId} 不存在`)

  // 收集直接上游输出
  const directUpstreamIds = edges.filter((e) => e.target === node.id).map((e) => e.source)
  const upstreamOutputs: { nodeName: string; output: NodeOutput }[] = []
  for (const upstreamId of directUpstreamIds) {
    const nodeResult = run.node_results[upstreamId]
    if (!nodeResult?.output) continue
    const upstreamNode = nodes.find((n) => n.id === upstreamId)
    if (!upstreamNode) continue
    try {
      const agent = await agentService.getAgent(upstreamNode.agentId)
      upstreamOutputs.push({ nodeName: agent.name, output: nodeResult.output })
    } catch {
      upstreamOutputs.push({ nodeName: upstreamId, output: nodeResult.output })
    }
  }

  const userMessage = buildUserMessage(upstreamOutputs, inputs)
  const agent = await agentService.getAgent(node.agentId)

  const session = await sessionService.createSession(STUDIO_USER_ID, {
    agentId: node.agentId,
    title: `Studio Run ${runId} - ${agent.name}`,
    metadata: { studioRunId: runId, nodeId: node.id },
  })

  logger.info('节点开始执行', { runId, nodeId: node.id, sessionId: session.id, agentId: node.agentId })

  try {
    await sendMessageToRuntime(session.id, userMessage, agent)
  } catch (error) {
    logger.warn('Runtime 调用失败，等待 session 状态', { sessionId: session.id, error: (error as Error).message })
  }

  const sessionStatus = await waitForCompletion(session.id, runId)

  if (sessionStatus === 'failed') {
    await studioRepo.saveNodeResult(runId, node.id, {
      status: 'failed',
      sessionId: session.id,
      error: 'session failed',
      completedAt: new Date().toISOString(),
    })
    throw new Error(`节点 ${node.id} 执行失败`)
  }

  const output = await collectNodeOutput(session.id)
  await studioRepo.saveNodeResult(runId, node.id, {
    status: 'completed',
    sessionId: session.id,
    output,
    completedAt: new Date().toISOString(),
  })

  logger.info('节点执行完成', { runId, nodeId: node.id, sessionId: session.id })
}

// ─── 主入口 ───────────────────────────────────────────────────

export async function runStudio(
  studioId: string,
  inputs: Record<string, unknown>
): Promise<string> {
  const studio = await studioRepo.findById(studioId)
  if (!studio) throw new Error(`Studio ${studioId} 不存在`)

  const run = await studioRepo.createRun(studioId, inputs)
  logger.info('Studio Run 开始', { runId: run.id, studioId })

  // 异步执行，不阻塞 HTTP 响应
  executeRunAsync(run.id, studio.nodes, studio.edges, inputs).catch((error) => {
    logger.error('Studio Run 异步执行失败', error as Error, { runId: run.id })
  })

  return run.id
}

async function executeRunAsync(
  runId: string,
  nodes: AgentNode[],
  edges: StudioEdge[],
  inputs: Record<string, unknown>
): Promise<void> {
  try {
    await studioRepo.updateRunStatus(runId, 'running')
    const layers = topologicalLayers(nodes, edges)

    for (const layer of layers) {
      const currentRun = await studioRepo.findRunById(runId)
      if (currentRun?.status === 'cancelled') {
        logger.info('Studio Run 已取消', { runId })
        return
      }

      // 过滤已完成节点（断点续传）
      const pending = layer.filter(
        (node) => currentRun?.node_results[node.id]?.status !== 'completed'
      )

      const results = await Promise.allSettled(
        pending.map((node) => executeNode(runId, node, nodes, edges, inputs))
      )

      const failed = results.find((r) => r.status === 'rejected')
      if (failed) {
        const reason = (failed as PromiseRejectedResult).reason as Error
        await studioRepo.updateRunStatus(runId, 'failed', reason?.message)
        logger.error('Studio Run 失败', reason, { runId })
        return
      }
    }

    await studioRepo.updateRunStatus(runId, 'completed')
    logger.info('Studio Run 完成', { runId })
  } catch (error) {
    await studioRepo.updateRunStatus(runId, 'failed', (error as Error).message)
    logger.error('Studio Run 异常', error as Error, { runId })
  }
}
