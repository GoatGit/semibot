/**
 * 统一错误处理中间件
 */
import type { Request, Response, NextFunction } from 'express';
export declare class AppError extends Error {
    readonly code: string;
    readonly statusCode: number;
    readonly details?: unknown;
    constructor(code: string, message?: string, details?: unknown);
}
/**
 * 创建业务错误
 */
export declare function createError(code: string, message?: string, details?: unknown): AppError;
/**
 * 统一错误处理中间件
 */
export declare function errorHandler(error: Error, req: Request, res: Response, _next: NextFunction): void;
/**
 * 404 处理中间件
 */
export declare function notFoundHandler(req: Request, res: Response): void;
/**
 * 异步处理包装器 - 自动捕获异步错误
 */
export declare function asyncHandler<T extends Request>(fn: (req: T, res: Response, next: NextFunction) => Promise<void>): (req: T, res: Response, next: NextFunction) => void;
/**
 * 请求验证中间件工厂
 */
export declare function validate<T>(schema: {
    parse: (data: unknown) => T;
}, source?: 'body' | 'query' | 'params'): (req: Request, res: Response, next: NextFunction) => void;
//# sourceMappingURL=errorHandler.d.ts.map