/**
 * 认证中间件
 *
 * 支持 API Key 和 JWT 两种认证方式
 */
import type { Request, Response, NextFunction } from 'express';
export interface AuthUser {
    userId: string;
    orgId: string;
    role: 'owner' | 'admin' | 'member' | 'api_service';
    permissions: string[];
}
export interface AuthRequest extends Request {
    user?: AuthUser;
}
/**
 * 认证中间件 - 验证请求的身份
 *
 * 支持:
 * - API Key: Authorization: Bearer sk-xxx
 * - JWT: Authorization: Bearer eyJxxx
 */
export declare function authenticate(req: AuthRequest, res: Response, next: NextFunction): void;
/**
 * 可选认证中间件 - 如果有 Token 则验证，没有则跳过
 */
export declare function optionalAuth(req: AuthRequest, res: Response, next: NextFunction): void;
/**
 * 权限检查中间件工厂
 *
 * @param requiredPermissions 需要的权限列表 (任一匹配即可)
 */
export declare function requirePermission(...requiredPermissions: string[]): (req: AuthRequest, res: Response, next: NextFunction) => void;
/**
 * 角色检查中间件工厂
 *
 * @param allowedRoles 允许的角色列表
 */
export declare function requireRole(...allowedRoles: AuthUser['role'][]): (req: AuthRequest, res: Response, next: NextFunction) => void;
/**
 * 生成 JWT Token (用于登录)
 */
export declare function generateToken(user: AuthUser): string;
/**
 * 生成 API Key (用于创建 API Key)
 */
export declare function generateApiKey(): Promise<{
    key: string;
    hash: string;
    prefix: string;
}>;
//# sourceMappingURL=auth.d.ts.map