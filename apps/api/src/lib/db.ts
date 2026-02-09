/**
 * 数据库连接配置
 *
 * 使用 postgres.js 作为 PostgreSQL 客户端
 */

import postgres from 'postgres'
import {
  DATABASE_URL,
  DB_POOL_MAX,
} from '../constants/config'
import { createLogger } from './logger'

const dbLogger = createLogger('database')

// ═══════════════════════════════════════════════════════════════
// 数据库连接实例
// ═══════════════════════════════════════════════════════════════

export const sql = postgres(DATABASE_URL, {
  max: DB_POOL_MAX,
  idle_timeout: 20,
  connect_timeout: 10,
  max_lifetime: 60 * 30, // 30 分钟
})

/**
 * 健康检查 - 测试数据库连接
 */
export async function checkDatabaseConnection(): Promise<boolean> {
  try {
    await sql`SELECT 1`
    return true
  } catch (error) {
    dbLogger.error('连接检查失败', error as Error)
    return false
  }
}

/**
 * 关闭数据库连接
 */
export async function closeDatabaseConnection(): Promise<void> {
  await sql.end()
  dbLogger.info('连接已关闭')
}

export default sql
