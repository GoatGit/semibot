/**
 * Auth Store 测试
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { useAuthStore } from '@/stores/authStore'

describe('Auth Store', () => {
  beforeEach(() => {
    // 重置 store 状态
    useAuthStore.setState({
      user: null,
      tokens: null,
      isAuthenticated: false,
      isLoading: false,
      error: null,
    })
  })

  describe('初始状态', () => {
    it('should have correct initial state', () => {
      const state = useAuthStore.getState()

      expect(state.user).toBeNull()
      expect(state.tokens).toBeNull()
      expect(state.isAuthenticated).toBe(false)
      expect(state.isLoading).toBe(false)
      expect(state.error).toBeNull()
    })
  })

  describe('setUser', () => {
    it('should set user and authenticate', () => {
      const mockUser = {
        id: 'user-123',
        email: 'test@example.com',
        name: 'Test User',
        role: 'member' as const,
        orgId: 'org-123',
        orgName: 'Test Org',
      }

      useAuthStore.getState().setUser(mockUser)
      const state = useAuthStore.getState()

      expect(state.user).toEqual(mockUser)
      expect(state.isAuthenticated).toBe(true)
    })
  })

  describe('setTokens', () => {
    it('should set tokens', () => {
      const mockTokens = {
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
        expiresAt: '2026-12-31T00:00:00Z',
      }

      useAuthStore.getState().setTokens(mockTokens)
      const state = useAuthStore.getState()

      expect(state.tokens).toEqual(mockTokens)
    })
  })

  describe('login', () => {
    it('should set user, tokens and authenticate', () => {
      const mockUser = {
        id: 'user-123',
        email: 'test@example.com',
        name: 'Test User',
        role: 'member' as const,
        orgId: 'org-123',
        orgName: 'Test Org',
      }

      const mockTokens = {
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
        expiresAt: '2026-12-31T00:00:00Z',
      }

      useAuthStore.getState().login(mockUser, mockTokens)
      const state = useAuthStore.getState()

      expect(state.user).toEqual(mockUser)
      expect(state.tokens).toEqual(mockTokens)
      expect(state.isAuthenticated).toBe(true)
      expect(state.error).toBeNull()
    })
  })

  describe('logout', () => {
    it('should clear user, tokens and authentication', () => {
      // 先登录
      useAuthStore.getState().login(
        {
          id: 'user-123',
          email: 'test@example.com',
          name: 'Test User',
          role: 'member' as const,
          orgId: 'org-123',
          orgName: 'Test Org',
        },
        {
          accessToken: 'access-token',
          refreshToken: 'refresh-token',
          expiresAt: '2026-12-31T00:00:00Z',
        }
      )

      // 然后登出
      useAuthStore.getState().logout()
      const state = useAuthStore.getState()

      expect(state.user).toBeNull()
      expect(state.tokens).toBeNull()
      expect(state.isAuthenticated).toBe(false)
    })
  })

  describe('setLoading', () => {
    it('should set loading state', () => {
      useAuthStore.getState().setLoading(true)
      expect(useAuthStore.getState().isLoading).toBe(true)

      useAuthStore.getState().setLoading(false)
      expect(useAuthStore.getState().isLoading).toBe(false)
    })
  })

  describe('setError', () => {
    it('should set error and clear loading', () => {
      useAuthStore.getState().setLoading(true)
      useAuthStore.getState().setError('Something went wrong')

      const state = useAuthStore.getState()
      expect(state.error).toBe('Something went wrong')
      expect(state.isLoading).toBe(false)
    })
  })

  describe('clearError', () => {
    it('should clear error', () => {
      useAuthStore.getState().setError('Some error')
      useAuthStore.getState().clearError()

      expect(useAuthStore.getState().error).toBeNull()
    })
  })

  describe('getAccessToken', () => {
    it('should return access token when available', () => {
      useAuthStore.getState().setTokens({
        accessToken: 'my-access-token',
        refreshToken: 'my-refresh-token',
        expiresAt: '2026-12-31T00:00:00Z',
      })

      expect(useAuthStore.getState().getAccessToken()).toBe('my-access-token')
    })

    it('should return null when no tokens', () => {
      expect(useAuthStore.getState().getAccessToken()).toBeNull()
    })
  })

  describe('getRefreshToken', () => {
    it('should return refresh token when available', () => {
      useAuthStore.getState().setTokens({
        accessToken: 'my-access-token',
        refreshToken: 'my-refresh-token',
        expiresAt: '2026-12-31T00:00:00Z',
      })

      expect(useAuthStore.getState().getRefreshToken()).toBe('my-refresh-token')
    })
  })

  describe('isTokenExpired', () => {
    it('should return true when no tokens', () => {
      expect(useAuthStore.getState().isTokenExpired()).toBe(true)
    })

    it('should return true when token is expired', () => {
      useAuthStore.getState().setTokens({
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
        expiresAt: '2020-01-01T00:00:00Z', // 过去的时间
      })

      expect(useAuthStore.getState().isTokenExpired()).toBe(true)
    })

    it('should return false when token is not expired', () => {
      const futureDate = new Date()
      futureDate.setFullYear(futureDate.getFullYear() + 1)

      useAuthStore.getState().setTokens({
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
        expiresAt: futureDate.toISOString(),
      })

      expect(useAuthStore.getState().isTokenExpired()).toBe(false)
    })
  })
})
