/**
 * Queue 服务
 *
 * 内存任务队列（替代 Redis Stream）
 */

import { xadd, xreadgroup, xack, xlen, createConsumerGroup, pingRedis } from '../lib/mem-store'
import { createLogger } from '../lib/logger'

const queueLogger = createLogger('queue')

export interface ChatTask {
  id: string
  userId: string
  sessionId: string
  agentId: string
  message: string
  parentMessageId?: string
  createdAt: string
}

export interface TaskResult {
  taskId: string
  status: 'success' | 'error'
  data?: unknown
  error?: string
}

export const CHAT_QUEUE_NAME = 'semibot:chat:queue'
export const CHAT_RESULT_PREFIX = 'semibot:chat:result:'
export const CONSUMER_GROUP = 'chat-workers'
export const CONSUMER_NAME = 'worker-1'
export const RESULT_TTL_SECONDS = 300

let isInitialized = false

export async function initializeQueue(): Promise<void> {
  if (isInitialized) return
  try {
    await createConsumerGroup(CHAT_QUEUE_NAME, CONSUMER_GROUP)
    isInitialized = true
    queueLogger.info('队列初始化完成')
  } catch (error) {
    queueLogger.error('队列初始化失败', error as Error)
  }
}

export async function enqueueTask(task: ChatTask): Promise<string> {
  queueLogger.debug('任务入队', { taskId: task.id, sessionId: task.sessionId })
  try {
    const messageId = await xadd(CHAT_QUEUE_NAME, { task: JSON.stringify(task) })
    queueLogger.info('任务已入队', { messageId })
    return messageId
  } catch (error) {
    queueLogger.error('任务入队失败', error as Error)
    throw error
  }
}

export async function dequeueTask(
  blockMs: number = 5000
): Promise<{ messageId: string; task: ChatTask } | null> {
  queueLogger.debug('尝试获取任务...')
  try {
    await initializeQueue()
    const messages = await xreadgroup(CONSUMER_GROUP, CONSUMER_NAME, CHAT_QUEUE_NAME, 1, blockMs)
    if (!messages || messages.length === 0) return null
    const { id, fields } = messages[0]
    const task = JSON.parse(fields.task) as ChatTask
    queueLogger.info('获取到任务', { messageId: id, taskId: task.id })
    return { messageId: id, task }
  } catch (error) {
    queueLogger.error('获取任务失败', error as Error)
    return null
  }
}

export async function acknowledgeTask(messageId: string): Promise<void> {
  queueLogger.debug('确认任务', { messageId })
  try {
    const ackCount = await xack(CHAT_QUEUE_NAME, CONSUMER_GROUP, messageId)
    queueLogger.info('任务已确认', { messageId, ackCount })
  } catch (error) {
    queueLogger.error('确认任务失败', error as Error)
    throw error
  }
}

// 结果存储（内存 Map）
const resultStore = new Map<string, { result: TaskResult; expiresAt: number }>()

export async function publishResult(taskId: string, result: TaskResult): Promise<void> {
  queueLogger.debug('发布结果', { taskId, status: result.status })
  resultStore.set(taskId, { result, expiresAt: Date.now() + RESULT_TTL_SECONDS * 1000 })
  queueLogger.info('结果已发布', { taskId })
}

export async function getResult(taskId: string): Promise<TaskResult | null> {
  const entry = resultStore.get(taskId)
  if (!entry) return null
  if (Date.now() > entry.expiresAt) {
    resultStore.delete(taskId)
    return null
  }
  return entry.result
}

export async function getQueueLength(): Promise<number> {
  try {
    const length = await xlen(CHAT_QUEUE_NAME)
    queueLogger.debug('队列长度', { length })
    return length
  } catch (error) {
    queueLogger.error('获取队列长度失败', error as Error)
    return 0
  }
}

export async function checkQueueHealth(): Promise<boolean> {
  try {
    return await pingRedis()
  } catch (error) {
    queueLogger.error('健康检查失败', error as Error)
    return false
  }
}
