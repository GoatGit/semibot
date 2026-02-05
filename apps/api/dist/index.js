/**
 * Semibot API 服务入口
 */
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { generalRateLimit } from './middleware/rateLimit.js';
import v1Router from './routes/v1/index.js';
import { SERVER_PORT, SERVER_HOST, ENABLE_REQUEST_LOGGING, LOG_LEVEL, } from './constants/config.js';
// ═══════════════════════════════════════════════════════════════
// 创建 Express 应用
// ═══════════════════════════════════════════════════════════════
const app = express();
// ═══════════════════════════════════════════════════════════════
// 基础中间件
// ═══════════════════════════════════════════════════════════════
// 安全头
app.use(helmet({
    contentSecurityPolicy: false, // SSE 需要禁用
}));
// CORS
app.use(cors({
    origin: process.env.CORS_ORIGIN ?? '*',
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-ID'],
    exposedHeaders: ['X-RateLimit-Limit', 'X-RateLimit-Remaining', 'X-RateLimit-Reset'],
}));
// 压缩
app.use(compression());
// JSON 解析
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
// 请求日志
if (ENABLE_REQUEST_LOGGING) {
    app.use((req, res, next) => {
        const start = Date.now();
        res.on('finish', () => {
            const duration = Date.now() - start;
            console.log(`[${new Date().toISOString()}] ${req.method} ${req.path} ${res.statusCode} ${duration}ms`);
        });
        next();
    });
}
// 通用限流
app.use(generalRateLimit);
// ═══════════════════════════════════════════════════════════════
// API 路由
// ═══════════════════════════════════════════════════════════════
// v1 API
app.use('/api/v1', v1Router);
// 根路径
app.get('/', (req, res) => {
    res.json({
        success: true,
        data: {
            name: 'Semibot API',
            version: '1.0.0',
            docs: '/api/v1/docs',
        },
    });
});
// ═══════════════════════════════════════════════════════════════
// 错误处理
// ═══════════════════════════════════════════════════════════════
// 404 处理
app.use(notFoundHandler);
// 统一错误处理
app.use(errorHandler);
// ═══════════════════════════════════════════════════════════════
// 启动服务器
// ═══════════════════════════════════════════════════════════════
const server = app.listen(SERVER_PORT, SERVER_HOST, () => {
    console.log(`
╔═══════════════════════════════════════════════════════════╗
║                    Semibot API Server                      ║
╠═══════════════════════════════════════════════════════════╣
║  Status:    Running                                        ║
║  Host:      ${SERVER_HOST.padEnd(46)}║
║  Port:      ${String(SERVER_PORT).padEnd(46)}║
║  Log Level: ${LOG_LEVEL.padEnd(46)}║
║  API:       http://${SERVER_HOST}:${SERVER_PORT}/api/v1${' '.repeat(24)}║
╚═══════════════════════════════════════════════════════════╝
  `);
});
// 优雅关闭
process.on('SIGTERM', () => {
    console.log('[Server] 收到 SIGTERM 信号，正在优雅关闭...');
    server.close(() => {
        console.log('[Server] 服务器已关闭');
        process.exit(0);
    });
});
process.on('SIGINT', () => {
    console.log('[Server] 收到 SIGINT 信号，正在优雅关闭...');
    server.close(() => {
        console.log('[Server] 服务器已关闭');
        process.exit(0);
    });
});
export default app;
//# sourceMappingURL=index.js.map