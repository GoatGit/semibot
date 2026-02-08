/**
 * Auth Service 测试
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock 数据库
vi.mock('../lib/db', () => ({
  sql: vi.fn(),
}))

// Mock Redis
vi.mock('../lib/redis', () => ({
  setWithExpiry: vi.fn().mockResolvedValue(undefined),
  exists: vi.fn().mockResolvedValue(false),
  get: vi.fn().mockResolvedValue(null),
  del: vi.fn().mockResolvedValue(1),
}))

vi.mock('../services/email.service', () => ({
  sendPasswordResetEmail: vi.fn().mockResolvedValue(undefined),
}))

// Mock bcryptjs
vi.mock('bcryptjs', () => ({
  default: {
    hash: vi.fn().mockResolvedValue('hashed_password'),
    compare: vi.fn().mockResolvedValue(true),
  },
}))

// Mock jsonwebtoken
vi.mock('jsonwebtoken', () => ({
  default: {
    sign: vi.fn().mockReturnValue('mock_token'),
    verify: vi.fn().mockReturnValue({
      userId: 'user-123',
      orgId: 'org-123',
      role: 'owner',
      permissions: ['*'],
      type: 'refresh',
    }),
    decode: vi.fn().mockReturnValue({ exp: Math.floor(Date.now() / 1000) + 3600 }),
  },
}))

import { sql } from '../lib/db'
import * as redis from '../lib/redis'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import { sendPasswordResetEmail } from '../services/email.service'

// 需要在 mock 之后导入
const mockSql = sql as unknown as ReturnType<typeof vi.fn>
const mockRedis = redis as {
  setWithExpiry: ReturnType<typeof vi.fn>
  exists: ReturnType<typeof vi.fn>
  get: ReturnType<typeof vi.fn>
  del: ReturnType<typeof vi.fn>
}

describe('Auth Service', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('register', () => {
    it('should throw error if email already exists', async () => {
      // 模拟邮箱已存在
      mockSql.mockResolvedValueOnce([{ id: 'existing-user' }])

      const { register } = await import('../services/auth.service')

      await expect(
        register({
          email: 'existing@example.com',
          password: 'password123',
          name: 'Test User',
          orgName: 'Test Org',
        })
      ).rejects.toEqual({ code: 'AUTH_EMAIL_EXISTS' })
    })

    it('should create user and organization on successful registration', async () => {
      // 模拟邮箱不存在
      mockSql.mockResolvedValueOnce([])
      // 模拟创建组织
      mockSql.mockResolvedValueOnce([
        { id: 'org-123', name: 'Test Org', slug: 'test-org-abc123' },
      ])
      // 模拟创建用户
      mockSql.mockResolvedValueOnce([
        { id: 'user-123', email: 'new@example.com', name: 'Test User', org_id: 'org-123', role: 'owner' },
      ])
      // 模拟更新组织 owner_id
      mockSql.mockResolvedValueOnce([])

      const { register } = await import('../services/auth.service')

      const result = await register({
        email: 'new@example.com',
        password: 'password123',
        name: 'Test User',
        orgName: 'Test Org',
      })

      expect(result.user.email).toBe('new@example.com')
      expect(result.user.role).toBe('owner')
      expect(result.organization?.name).toBe('Test Org')
      expect(result.token).toBeDefined()
      expect(result.refreshToken).toBeDefined()
    })
  })

  describe('login', () => {
    it('should throw error if user not found', async () => {
      mockSql.mockResolvedValueOnce([])

      const { login } = await import('../services/auth.service')

      await expect(
        login({
          email: 'notfound@example.com',
          password: 'password123',
        })
      ).rejects.toEqual({ code: 'AUTH_USER_NOT_FOUND' })
    })

    it('should throw error if user is inactive', async () => {
      mockSql.mockResolvedValueOnce([
        {
          id: 'user-123',
          email: 'inactive@example.com',
          password_hash: 'hashed',
          name: 'Inactive User',
          org_id: 'org-123',
          role: 'member',
          is_active: false,
        },
      ])

      const { login } = await import('../services/auth.service')

      await expect(
        login({
          email: 'inactive@example.com',
          password: 'password123',
        })
      ).rejects.toEqual({ code: 'AUTH_USER_INACTIVE' })
    })

    it('should throw error if password is invalid', async () => {
      mockSql.mockResolvedValueOnce([
        {
          id: 'user-123',
          email: 'user@example.com',
          password_hash: 'hashed',
          name: 'Test User',
          org_id: 'org-123',
          role: 'member',
          is_active: true,
        },
      ])

      // 模拟密码不匹配
      vi.mocked(bcrypt.compare).mockResolvedValueOnce(false as never)

      const { login } = await import('../services/auth.service')

      await expect(
        login({
          email: 'user@example.com',
          password: 'wrongpassword',
        })
      ).rejects.toEqual({ code: 'AUTH_INVALID_PASSWORD' })
    })

    it('should return tokens on successful login', async () => {
      mockSql.mockResolvedValueOnce([
        {
          id: 'user-123',
          email: 'user@example.com',
          password_hash: 'hashed',
          name: 'Test User',
          org_id: 'org-123',
          role: 'member',
          is_active: true,
        },
      ])
      // 模拟更新最后登录时间
      mockSql.mockResolvedValueOnce([])

      vi.mocked(bcrypt.compare).mockResolvedValueOnce(true as never)

      const { login } = await import('../services/auth.service')

      const result = await login({
        email: 'user@example.com',
        password: 'password123',
      })

      expect(result.user.email).toBe('user@example.com')
      expect(result.token).toBeDefined()
      expect(result.refreshToken).toBeDefined()
    })
  })

  describe('refreshToken', () => {
    it('should throw error if refresh token is invalid', async () => {
      vi.mocked(jwt.verify).mockImplementationOnce(() => {
        throw new Error('Invalid token')
      })

      const { refreshToken } = await import('../services/auth.service')

      await expect(refreshToken('invalid_token')).rejects.toEqual({
        code: 'AUTH_REFRESH_TOKEN_INVALID',
      })
    })

    it('should throw error if token type is not refresh', async () => {
      vi.mocked(jwt.verify).mockReturnValueOnce({
        userId: 'user-123',
        orgId: 'org-123',
        role: 'owner',
        permissions: ['*'],
        type: 'access', // 不是 refresh 类型
      } as never)

      const { refreshToken } = await import('../services/auth.service')

      await expect(refreshToken('access_token')).rejects.toEqual({
        code: 'AUTH_REFRESH_TOKEN_INVALID',
      })
    })

    it('should return new tokens on valid refresh', async () => {
      vi.mocked(jwt.verify).mockReturnValueOnce({
        userId: 'user-123',
        orgId: 'org-123',
        role: 'owner',
        permissions: ['*'],
        type: 'refresh',
      } as never)

      mockSql.mockResolvedValueOnce([
        {
          id: 'user-123',
          email: 'user@example.com',
          name: 'Test User',
          org_id: 'org-123',
          role: 'owner',
          is_active: true,
        },
      ])

      const { refreshToken } = await import('../services/auth.service')

      const result = await refreshToken('valid_refresh_token')

      expect(result.user.id).toBe('user-123')
      expect(result.token).toBeDefined()
      expect(result.refreshToken).toBeDefined()
    })
  })

  describe('logout', () => {
    it('should log logout event', async () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

      const { logout } = await import('../services/auth.service')

      await logout('user-123')

      expect(consoleSpy).toHaveBeenCalledWith('[Auth] 用户 user-123 已登出')
      consoleSpy.mockRestore()
    })

    it('should add access token to blacklist on logout', async () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

      // 创建一个有效的 mock token，过期时间在未来
      const futureExp = Math.floor(Date.now() / 1000) + 3600 // 1小时后过期
      vi.mocked(jwt.decode).mockReturnValueOnce({ exp: futureExp })

      const { logout } = await import('../services/auth.service')

      await logout('user-123', 'mock_access_token')

      expect(mockRedis.setWithExpiry).toHaveBeenCalled()
      expect(consoleSpy).toHaveBeenCalledWith('[Auth] 用户 user-123 已登出')
      consoleSpy.mockRestore()
    })

    it('should add both access and refresh tokens to blacklist', async () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

      const futureExp = Math.floor(Date.now() / 1000) + 3600
      vi.mocked(jwt.decode)
        .mockReturnValueOnce({ exp: futureExp }) // access token
        .mockReturnValueOnce({ exp: futureExp + 86400 }) // refresh token

      const { logout } = await import('../services/auth.service')

      await logout('user-123', 'mock_access_token', 'mock_refresh_token')

      // 应该调用两次 setWithExpiry
      expect(mockRedis.setWithExpiry).toHaveBeenCalledTimes(2)
      consoleSpy.mockRestore()
    })

    it('should skip blacklist for expired tokens', async () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

      // Token 已过期
      const pastExp = Math.floor(Date.now() / 1000) - 100
      vi.mocked(jwt.decode).mockReturnValueOnce({ exp: pastExp })

      const { logout } = await import('../services/auth.service')

      await logout('user-123', 'expired_token')

      // 不应调用 setWithExpiry，因为 token 已过期
      expect(mockRedis.setWithExpiry).not.toHaveBeenCalled()
      consoleSpy.mockRestore()
      warnSpy.mockRestore()
    })
  })

  describe('Token Blacklist', () => {
    it('addToBlacklist should store token in Redis with TTL', async () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

      const { addToBlacklist } = await import('../services/auth.service')

      await addToBlacklist('test_token', 3600)

      expect(mockRedis.setWithExpiry).toHaveBeenCalledWith(
        'token:blacklist:test_token',
        '1',
        3600
      )
      consoleSpy.mockRestore()
    })

    it('addToBlacklist should skip if TTL <= 0', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

      const { addToBlacklist } = await import('../services/auth.service')

      await addToBlacklist('test_token', 0)

      expect(mockRedis.setWithExpiry).not.toHaveBeenCalled()
      expect(warnSpy).toHaveBeenCalled()
      warnSpy.mockRestore()
    })

    it('isBlacklisted should check Redis for token', async () => {
      mockRedis.exists.mockResolvedValueOnce(true)

      const { isBlacklisted } = await import('../services/auth.service')

      const result = await isBlacklisted('blacklisted_token')

      expect(result).toBe(true)
      expect(mockRedis.exists).toHaveBeenCalledWith('token:blacklist:blacklisted_token')
    })

    it('isBlacklisted should return false for non-blacklisted token', async () => {
      mockRedis.exists.mockResolvedValueOnce(false)

      const { isBlacklisted } = await import('../services/auth.service')

      const result = await isBlacklisted('valid_token')

      expect(result).toBe(false)
    })
  })

  describe('Password Reset', () => {
    it('requestPasswordReset should return silently for unknown email', async () => {
      mockRedis.exists.mockResolvedValueOnce(false)
      mockSql.mockResolvedValueOnce([])

      const { requestPasswordReset } = await import('../services/auth.service')
      await expect(requestPasswordReset('unknown@example.com')).resolves.not.toThrow()

      expect(mockRedis.setWithExpiry).toHaveBeenCalledTimes(1)
      expect(sendPasswordResetEmail).not.toHaveBeenCalled()
    })

    it('requestPasswordReset should generate token and send email for existing user', async () => {
      mockRedis.exists.mockResolvedValueOnce(false)
      mockSql.mockResolvedValueOnce([{ id: 'user-123' }])

      const { requestPasswordReset } = await import('../services/auth.service')
      await requestPasswordReset('user@example.com')

      expect(mockRedis.setWithExpiry).toHaveBeenCalledTimes(2)
      expect(sendPasswordResetEmail).toHaveBeenCalledWith(
        expect.objectContaining({ email: 'user@example.com' })
      )
    })

    it('requestPasswordReset should skip when throttled', async () => {
      mockRedis.exists.mockResolvedValueOnce(true)

      const { requestPasswordReset } = await import('../services/auth.service')
      await expect(requestPasswordReset('user@example.com')).resolves.not.toThrow()

      expect(mockSql).not.toHaveBeenCalled()
      expect(sendPasswordResetEmail).not.toHaveBeenCalled()
    })

    it('resetPassword should throw when token missing', async () => {
      mockRedis.get.mockResolvedValueOnce(null)

      const { resetPassword } = await import('../services/auth.service')
      await expect(resetPassword('invalid', 'new-password-123')).rejects.toEqual({
        code: 'AUTH_RESET_TOKEN_EXPIRED',
      })
    })

    it('resetPassword should update password and clear token', async () => {
      mockRedis.get.mockResolvedValueOnce('user-123')
      mockSql
        .mockResolvedValueOnce([{ id: 'user-123' }])
        .mockResolvedValueOnce([])

      const { resetPassword } = await import('../services/auth.service')
      await expect(resetPassword('valid-token', 'new-password-123')).resolves.not.toThrow()

      expect(mockRedis.del).toHaveBeenCalledTimes(1)
    })
  })
})
