import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { STORAGE_KEYS } from '@/constants/config'
import { AUTH_DISABLED } from '@/lib/auth-mode'

/**
 * Auth Store - 认证状态管理
 *
 * 功能:
 * - 用户登录/登出状态
 * - Token 管理 (access token + refresh token)
 * - 用户信息存储
 * - 自动刷新 token
 */

export interface User {
  id: string
  email: string
  name: string
  role: 'owner' | 'admin' | 'member'
  orgId: string
  orgName: string
}

export interface AuthTokens {
  accessToken: string
  refreshToken: string
  expiresAt: string
}

interface AuthState {
  // 状态
  user: User | null
  tokens: AuthTokens | null
  isAuthenticated: boolean
  isLoading: boolean
  error: string | null

  // 动作
  setUser: (user: User) => void
  setTokens: (tokens: AuthTokens) => void
  login: (user: User, tokens: AuthTokens) => void
  logout: () => void
  setLoading: (loading: boolean) => void
  setError: (error: string | null) => void
  clearError: () => void

  // Token 相关
  getAccessToken: () => string | null
  getRefreshToken: () => string | null
  isTokenExpired: () => boolean
}

const SINGLE_USER_DEFAULT: User = {
  id: process.env.NEXT_PUBLIC_SINGLE_USER_ID || '22222222-2222-2222-2222-222222222222',
  email: process.env.NEXT_PUBLIC_SINGLE_USER_EMAIL || 'admin@semibot.local',
  name: process.env.NEXT_PUBLIC_SINGLE_USER_NAME || 'Semibot Admin',
  role: 'owner',
  orgId: process.env.NEXT_PUBLIC_SINGLE_ORG_ID || '11111111-1111-1111-1111-111111111111',
  orgName: process.env.NEXT_PUBLIC_SINGLE_ORG_NAME || 'Semibot',
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set, get) => ({
      // 初始状态
      user: AUTH_DISABLED ? SINGLE_USER_DEFAULT : null,
      tokens: null,
      isAuthenticated: AUTH_DISABLED,
      isLoading: false,
      error: null,

      // 设置用户
      setUser: (user) =>
        set({
          user,
          isAuthenticated: true,
        }),

      // 设置 Token
      setTokens: (tokens) =>
        set({
          tokens,
        }),

      // 登录
      login: (user, tokens) =>
        set({
          user,
          tokens,
          isAuthenticated: true,
          error: null,
        }),

      // 登出
      logout: () => {
        if (AUTH_DISABLED) {
          set({
            user: SINGLE_USER_DEFAULT,
            tokens: null,
            isAuthenticated: true,
            error: null,
          })
          return
        }

        // 清除 cookie（用于中间件认证）
        if (typeof document !== 'undefined') {
          document.cookie = 'auth_token=; path=/; max-age=0; samesite=strict'
        }

        // 清除 localStorage
        if (typeof window !== 'undefined') {
          localStorage.removeItem(STORAGE_KEYS.AUTH_TOKEN)
          localStorage.removeItem(STORAGE_KEYS.REFRESH_TOKEN)
        }

        set({
          user: null,
          tokens: null,
          isAuthenticated: false,
          error: null,
        })
      },

      // 设置加载状态
      setLoading: (loading) =>
        set({
          isLoading: loading,
        }),

      // 设置错误
      setError: (error) =>
        set({
          error,
          isLoading: false,
        }),

      // 清除错误
      clearError: () =>
        set({
          error: null,
        }),

      // 获取 Access Token
      getAccessToken: () => {
        const { tokens } = get()
        return tokens?.accessToken ?? null
      },

      // 获取 Refresh Token
      getRefreshToken: () => {
        const { tokens } = get()
        return tokens?.refreshToken ?? null
      },

      // 检查 Token 是否过期
      isTokenExpired: () => {
        const { tokens } = get()
        if (!tokens?.expiresAt) return true

        const expiresAt = new Date(tokens.expiresAt)
        const now = new Date()
        // 提前 5 分钟认为过期，以便刷新
        const bufferMs = 5 * 60 * 1000
        return now.getTime() > expiresAt.getTime() - bufferMs
      },
    }),
    {
      name: 'auth-storage',
      partialize: (state) => ({
        user: state.user,
        tokens: state.tokens,
        isAuthenticated: state.isAuthenticated,
      }),
      merge: (persistedState, currentState) => {
        const merged = {
          ...currentState,
          ...(persistedState as Partial<AuthState> | undefined),
        }

        if (AUTH_DISABLED) {
          return {
            ...merged,
            user: merged.user ?? SINGLE_USER_DEFAULT,
            tokens: null,
            isAuthenticated: true,
            error: null,
          }
        }

        return merged
      },
    }
  )
)

/**
 * 选择器 - 用于性能优化
 */
export const selectUser = (state: AuthState) => state.user
export const selectIsAuthenticated = (state: AuthState) => state.isAuthenticated
export const selectIsLoading = (state: AuthState) => state.isLoading
export const selectError = (state: AuthState) => state.error
