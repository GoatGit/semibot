/**
 * Semibot API 服务入口
 */

import { config } from 'dotenv'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

// 加载项目根目录的 .env.local（优先）和 .env
const __dirname = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(__dirname, '..', '..', '..')
config({ path: resolve(projectRoot, '.env.local') })
config({ path: resolve(projectRoot, '.env') })

import express, { type Express, type Request, type Response, type NextFunction } from 'express'
import cors from 'cors'
import helmet from 'helmet'
import compression from 'compression'
import { errorHandler, notFoundHandler } from './middleware/errorHandler'
import { generalRateLimit } from './middleware/rateLimit'
import v1Router from './routes/v1/index'
import {
  SERVER_PORT,
  SERVER_HOST,
  ENABLE_REQUEST_LOGGING,
  LOG_LEVEL,
} from './constants/config'
import { createLogger } from './lib/logger'

const serverLogger = createLogger('server')

// ═══════════════════════════════════════════════════════════════
// 创建 Express 应用
// ═══════════════════════════════════════════════════════════════

const app: Express = express()

// ═══════════════════════════════════════════════════════════════
// 基础中间件
// ═══════════════════════════════════════════════════════════════

// 安全头
app.use(helmet({
  contentSecurityPolicy: false, // SSE 需要禁用
}))

// CORS
app.use(cors({
  origin: process.env.CORS_ORIGIN ?? '*',
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-ID'],
  exposedHeaders: ['X-RateLimit-Limit', 'X-RateLimit-Remaining', 'X-RateLimit-Reset'],
}))

// 压缩
app.use(compression())

// JSON 解析
app.use(express.json({ limit: '10mb' }))
app.use(express.urlencoded({ extended: true }))

// 请求日志
if (ENABLE_REQUEST_LOGGING) {
  app.use((req: Request, res: Response, next: NextFunction) => {
    const start = Date.now()

    res.on('finish', () => {
      const duration = Date.now() - start
      serverLogger.debug('请求完成', {
        method: req.method,
        path: req.path,
        status: res.statusCode,
        duration,
      })
    })

    next()
  })
}

// 通用限流
app.use(generalRateLimit)

// ═══════════════════════════════════════════════════════════════
// API 路由
// ═══════════════════════════════════════════════════════════════

// v1 API
app.use('/api/v1', v1Router)

// 根路径
app.get('/', (_req: Request, res: Response) => {
  res.json({
    success: true,
    data: {
      name: 'Semibot API',
      version: '1.0.0',
      docs: '/api/v1/docs',
    },
  })
})

// ═══════════════════════════════════════════════════════════════
// 错误处理
// ═══════════════════════════════════════════════════════════════

// 404 处理
app.use(notFoundHandler)

// 统一错误处理
app.use(errorHandler)

// ═══════════════════════════════════════════════════════════════
// 启动服务器
// ═══════════════════════════════════════════════════════════════

const server = app.listen(SERVER_PORT, SERVER_HOST, () => {
  serverLogger.info('服务器已启动', {
    host: SERVER_HOST,
    port: SERVER_PORT,
    logLevel: LOG_LEVEL,
    api: `http://${SERVER_HOST}:${SERVER_PORT}/api/v1`,
  })
})

// 优雅关闭
process.on('SIGTERM', () => {
  serverLogger.info('收到 SIGTERM 信号，正在优雅关闭...')
  server.close(() => {
    serverLogger.info('服务器已关闭')
    process.exit(0)
  })
})

process.on('SIGINT', () => {
  serverLogger.info('收到 SIGINT 信号，正在优雅关闭...')
  server.close(() => {
    serverLogger.info('服务器已关闭')
    process.exit(0)
  })
})

export default app
