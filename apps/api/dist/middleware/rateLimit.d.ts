/**
 * 限流中间件
 *
 * 支持用户级和组织级限流
 */
import type { Response, NextFunction } from 'express';
import type { AuthRequest } from './auth.js';
/**
 * 用户级限流中间件
 */
export declare function userRateLimit(req: AuthRequest, res: Response, next: NextFunction): void;
/**
 * 组织级限流中间件
 */
export declare function orgRateLimit(req: AuthRequest, res: Response, next: NextFunction): void;
/**
 * 组合限流中间件 (先检查用户级，再检查组织级)
 */
export declare function combinedRateLimit(req: AuthRequest, res: Response, next: NextFunction): void;
/**
 * 创建自定义限流中间件
 *
 * @param limit 限制次数
 * @param windowMs 窗口大小 (毫秒)
 * @param keyGenerator 生成限流 key 的函数
 */
export declare function createRateLimit(options: {
    limit: number;
    windowMs: number;
    keyGenerator?: (req: AuthRequest) => string;
    message?: string;
}): (req: AuthRequest, res: Response, next: NextFunction) => void;
/**
 * 基于 express-rate-limit 的通用限流 (用于简单场景)
 */
export declare const generalRateLimit: import("express-rate-limit").RateLimitRequestHandler;
//# sourceMappingURL=rateLimit.d.ts.map