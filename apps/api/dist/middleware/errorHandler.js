/**
 * 统一错误处理中间件
 */
import { ZodError } from 'zod';
import { INTERNAL_ERROR, VALIDATION_FAILED, ERROR_HTTP_STATUS, ERROR_MESSAGES, } from '../constants/errorCodes.js';
// ═══════════════════════════════════════════════════════════════
// 自定义错误类
// ═══════════════════════════════════════════════════════════════
export class AppError extends Error {
    code;
    statusCode;
    details;
    constructor(code, message, details) {
        super(message ?? ERROR_MESSAGES[code] ?? '未知错误');
        this.code = code;
        this.statusCode = ERROR_HTTP_STATUS[code] ?? 500;
        this.details = details;
        this.name = 'AppError';
        // 捕获堆栈跟踪
        Error.captureStackTrace(this, this.constructor);
    }
}
/**
 * 创建业务错误
 */
export function createError(code, message, details) {
    return new AppError(code, message, details);
}
/**
 * 格式化 Zod 验证错误
 */
function formatZodError(error) {
    const details = error.errors.map((e) => ({
        path: e.path.join('.'),
        message: e.message,
    }));
    return {
        success: false,
        error: {
            code: VALIDATION_FAILED,
            message: ERROR_MESSAGES[VALIDATION_FAILED],
            details,
        },
    };
}
/**
 * 格式化 AppError
 */
function formatAppError(error) {
    return {
        success: false,
        error: {
            code: error.code,
            message: error.message,
            details: error.details,
        },
    };
}
/**
 * 格式化通用错误
 */
function formatGenericError(error) {
    // 生产环境不暴露内部错误详情
    const isProduction = process.env.NODE_ENV === 'production';
    return {
        success: false,
        error: {
            code: INTERNAL_ERROR,
            message: isProduction ? ERROR_MESSAGES[INTERNAL_ERROR] : error.message,
            details: isProduction ? undefined : error.stack,
        },
    };
}
// ═══════════════════════════════════════════════════════════════
// 中间件
// ═══════════════════════════════════════════════════════════════
/**
 * 统一错误处理中间件
 */
export function errorHandler(error, req, res, _next) {
    // 记录错误日志
    console.error(`[Error] ${req.method} ${req.path}`, {
        error: error.message,
        stack: error.stack,
        body: req.body,
        query: req.query,
    });
    // Zod 验证错误
    if (error instanceof ZodError) {
        const response = formatZodError(error);
        res.status(400).json(response);
        return;
    }
    // 业务错误
    if (error instanceof AppError) {
        const response = formatAppError(error);
        res.status(error.statusCode).json(response);
        return;
    }
    // 其他错误
    const response = formatGenericError(error);
    res.status(500).json(response);
}
/**
 * 404 处理中间件
 */
export function notFoundHandler(req, res) {
    res.status(404).json({
        success: false,
        error: {
            code: 'RESOURCE_NOT_FOUND',
            message: `路由不存在: ${req.method} ${req.path}`,
        },
    });
}
/**
 * 异步处理包装器 - 自动捕获异步错误
 */
export function asyncHandler(fn) {
    return (req, res, next) => {
        Promise.resolve(fn(req, res, next)).catch(next);
    };
}
/**
 * 请求验证中间件工厂
 */
export function validate(schema, source = 'body') {
    return (req, res, next) => {
        try {
            const data = req[source];
            const validated = schema.parse(data);
            // 将验证后的数据替换原数据
            if (source === 'body') {
                req.body = validated;
            }
            else if (source === 'query') {
                req.query = validated;
            }
            else if (source === 'params') {
                req.params = validated;
            }
            next();
        }
        catch (error) {
            next(error);
        }
    };
}
//# sourceMappingURL=errorHandler.js.map