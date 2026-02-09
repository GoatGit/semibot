/**
 * Queue 服务
 *
 * 使用 Redis Stream 实现任务队列
 */

import * as redis from '../lib/redis'
import { createLogger } from '../lib/logger'

const queueLogger = createLogger('queue')

// ═══════════════════════════════════════════════════════════════
// 类型定义
// ═══════════════════════════════════════════════════════════════

export interface ChatTask {
  id: string
  orgId: string
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

// ═══════════════════════════════════════════════════════════════
// 队列常量
// ═══════════════════════════════════════════════════════════════

export const CHAT_QUEUE_NAME = 'semibot:chat:queue'
export const CHAT_RESULT_PREFIX = 'semibot:chat:result:'
export const CONSUMER_GROUP = 'chat-workers'
export const CONSUMER_NAME = 'worker-1'
export const RESULT_TTL_SECONDS = 300

// ═══════════════════════════════════════════════════════════════
// 初始化
// ═══════════════════════════════════════════════════════════════

let isInitialized = false

/**
 * 初始化队列 (创建消费者组)
 */
export async function initializeQueue(): Promise<void> {
  if (isInitialized) return

  try {
    await redis.createConsumerGroup(CHAT_QUEUE_NAME, CONSUMER_GROUP)
    isInitialized = true
    queueLogger.info('队列初始化完成')
  } catch (error) {
    queueLogger.error('队列初始化失败', error as Error)
  }
}

// ═══════════════════════════════════════════════════════════════
// 队列服务方法
// ═══════════════════════════════════════════════════════════════

/**
 * 将任务推入队列
 */
export async function enqueueTask(task: ChatTask): Promise<string> {
  queueLogger.debug('任务入队', { taskId: task.id, sessionId: task.sessionId })

  try {
    const messageId = await redis.xadd(CHAT_QUEUE_NAME, {
      task: JSON.stringify(task),
    })

    queueLogger.info('任务已入队', { messageId })
    return messageId
  } catch (error) {
    queueLogger.error('任务入队失败', error as Error)
    throw error
  }
}

/**
 * 从队列中获取任务
 */
export async function dequeueTask(
  blockMs: number = 5000
): Promise<{ messageId: string; task: ChatTask } | null> {
  queueLogger.debug('尝试获取任务...')

  try {
    // 确保队列已初始化
    await initializeQueue()

    const messages = await redis.xreadgroup(
      CONSUMER_GROUP,
      CONSUMER_NAME,
      CHAT_QUEUE_NAME,
      1,
      blockMs
    )

    if (!messages || messages.length === 0) {
      return null
    }

    const { id, fields } = messages[0]
    const task = JSON.parse(fields.task) as ChatTask

    queueLogger.info('获取到任务', { messageId: id, taskId: task.id })
    return { messageId: id, task }
  } catch (error) {
    queueLogger.error('获取任务失败', error as Error)
    return null
  }
}

/**
 * 确认任务完成
 */
export async function acknowledgeTask(messageId: string): Promise<void> {
  queueLogger.debug('确认任务', { messageId })

  try {
    const ackCount = await redis.xack(CHAT_QUEUE_NAME, CONSUMER_GROUP, messageId)
    queueLogger.info('任务已确认', { messageId, ackCount })
  } catch (error) {
    queueLogger.error('确认任务失败', error as Error)
    throw error
  }
}

/**
 * 发布任务结果
 */
export async function publishResult(taskId: string, result: TaskResult): Promise<void> {
  queueLogger.debug('发布结果', { taskId, status: result.status })

  try {
    const resultKey = `${CHAT_RESULT_PREFIX}${taskId}`
    await redis.setWithExpiry(resultKey, JSON.stringify(result), RESULT_TTL_SECONDS)

    // 同时发布到 Pub/Sub 频道，以便实时通知
    await redis.publish(`semibot:chat:result`, JSON.stringify(result))

    queueLogger.info('结果已发布', { resultKey })
  } catch (error) {
    queueLogger.error('发布结果失败', error as Error)
    throw error
  }
}

/**
 * 获取任务结果
 */
export async function getResult(taskId: string): Promise<TaskResult | null> {
  try {
    const resultKey = `${CHAT_RESULT_PREFIX}${taskId}`
    const resultStr = await redis.get(resultKey)

    if (!resultStr) {
      return null
    }

    return JSON.parse(resultStr) as TaskResult
  } catch (error) {
    queueLogger.error('获取结果失败', error as Error)
    return null
  }
}

/**
 * 获取队列长度
 */
export async function getQueueLength(): Promise<number> {
  try {
    const length = await redis.xlen(CHAT_QUEUE_NAME)
    queueLogger.debug('队列长度', { length })
    return length
  } catch (error) {
    queueLogger.error('获取队列长度失败', error as Error)
    return 0
  }
}

/**
 * 健康检查
 */
export async function checkQueueHealth(): Promise<boolean> {
  try {
    const isHealthy = await redis.pingRedis()
    queueLogger.debug('健康检查', { isHealthy })
    return isHealthy
  } catch (error) {
    queueLogger.error('健康检查失败', error as Error)
    return false
  }
}
