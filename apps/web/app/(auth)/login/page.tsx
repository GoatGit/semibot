'use client'

import { useState, Suspense } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import Link from 'next/link'
import clsx from 'clsx'
import { Mail, Lock, Eye, EyeOff, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Card, CardContent } from '@/components/ui/Card'
import { useAuthStore } from '@/stores/authStore'
import { apiClient } from '@/lib/api'

interface LoginResponse {
  success: boolean
  data: {
    user: {
      id: string
      email: string
      name: string
      role: 'owner' | 'admin' | 'member'
    }
    token: string
    refreshToken?: string
    refresh_token?: string
    expiresAt?: string
    expires_at?: string
  }
  error?: {
    code: string
    message: string
  }
}

/**
 * 登录表单组件 (包含 useSearchParams)
 */
function LoginForm() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const redirectTo = searchParams.get('redirect') || '/'

  const { login, setLoading, setError, isLoading, error } = useAuthStore()

  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [rememberMe, setRememberMe] = useState(false)

  const normalizeEmail = (value: string) => value.trim().toLowerCase()
  const isValidEmail = (value: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()

    const normalizedEmail = normalizeEmail(email)
    if (!normalizedEmail || !password.trim()) {
      setError('邮箱和密码不能为空')
      return
    }

    if (!isValidEmail(normalizedEmail)) {
      setError('邮箱格式无效')
      return
    }

    setLoading(true)

    try {
      const response = await apiClient.post<LoginResponse>('/auth/login', {
        email: normalizedEmail,
        password,
      })

      if (response.success && response.data) {
        const { user, token } = response.data
        const refreshToken =
          response.data.refreshToken ?? response.data.refresh_token ?? ''
        const expiresAt =
          response.data.expiresAt ?? response.data.expires_at ?? ''

        // 存储到 cookie (用于中间件验证)
        if (typeof document !== 'undefined') {
          const maxAge = rememberMe ? 30 * 24 * 60 * 60 : 24 * 60 * 60 // 30天或1天
          document.cookie = `auth_token=${token}; path=/; max-age=${maxAge}; samesite=strict`
          // 同时存储到 localStorage (用于 API 请求)
          localStorage.setItem('auth_token', token)
        }

        // 更新 store
        login(
          {
            id: user.id,
            email: user.email,
            name: user.name,
            role: user.role,
            orgId: '', // 从其他接口获取
            orgName: '',
          },
          {
            accessToken: token,
            refreshToken,
            expiresAt,
          }
        )

        // 跳转
        router.push(redirectTo)
      } else {
        const errorCode = response.error?.code
        if (errorCode === 'AUTH_USER_NOT_FOUND' || errorCode === 'AUTH_INVALID_PASSWORD') {
          setError('邮箱或密码错误')
        } else {
          setError(response.error?.message || '登录失败')
        }
      }
    } catch (err) {
      console.error('[Login] 登录失败:', err)
      setError('网络错误，请稍后重试')
    }
  }

  return (
    <Card>
      <CardContent>
        <h2 className="text-xl font-semibold text-text-primary text-center mb-6">
          登录账户
        </h2>

        <form onSubmit={handleSubmit} noValidate className="space-y-4">
          {/* 错误提示 */}
          {error && (
            <div className="p-3 rounded-md bg-error-500/10 border border-error-500/20">
              <p className="text-sm text-error-500">{error}</p>
            </div>
          )}

          {/* 邮箱 */}
          <div>
            <label
              htmlFor="login-email"
              className="block text-sm font-medium text-text-secondary mb-1.5"
            >
              邮箱
            </label>
            <Input
              id="login-email"
              type="email"
              placeholder="请输入邮箱"
              value={email}
              onChange={(e) => {
                setEmail(e.target.value)
                if (error) setError(null)
              }}
              leftIcon={<Mail size={16} />}
              disabled={isLoading}
              aria-label="邮箱"
            />
          </div>

          {/* 密码 */}
          <div>
            <label
              htmlFor="login-password"
              className="block text-sm font-medium text-text-secondary mb-1.5"
            >
              密码
            </label>
            <div className="relative">
              <Input
                id="login-password"
                type={showPassword ? 'text' : 'password'}
                placeholder="请输入密码"
                value={password}
                onChange={(e) => {
                  setPassword(e.target.value)
                  if (error) setError(null)
                }}
                leftIcon={<Lock size={16} />}
                disabled={isLoading}
                aria-label="密码"
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                className={clsx(
                  'absolute right-3 top-1/2 -translate-y-1/2',
                  'p-1 text-text-tertiary hover:text-text-primary',
                  'transition-colors'
                )}
                aria-label={showPassword ? '隐藏密码' : '显示密码'}
              >
                {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
          </div>

          {/* 记住我 & 忘记密码 */}
          <div className="flex items-center justify-between">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={rememberMe}
                onChange={(e) => setRememberMe(e.target.checked)}
                className={clsx(
                  'w-4 h-4 rounded border-border-default',
                  'text-primary-500 focus:ring-primary-500'
                )}
              />
              <span className="text-sm text-text-secondary">记住我</span>
            </label>

            <Link
              href="/forgot-password"
              className="text-sm text-primary-400 hover:text-primary-300 transition-colors"
            >
              忘记密码？
            </Link>
          </div>

          {/* 登录按钮 */}
          <Button
            type="submit"
            className="w-full"
            disabled={isLoading}
          >
            {isLoading ? (
              <>
                <Loader2 size={16} className="animate-spin mr-2" />
                登录中...
              </>
            ) : (
              '登录'
            )}
          </Button>
        </form>

        {/* 注册链接 */}
        <p className="text-sm text-text-secondary text-center mt-6">
          还没有账户？{' '}
          <Link
            href="/register"
            className="text-primary-400 hover:text-primary-300 transition-colors"
          >
            立即注册
          </Link>
        </p>
      </CardContent>
    </Card>
  )
}

/**
 * 登录页面
 */
export default function LoginPage() {
  return (
    <Suspense fallback={
      <Card>
        <CardContent>
          <div className="flex items-center justify-center py-8">
            <Loader2 size={24} className="animate-spin text-primary-500" />
          </div>
        </CardContent>
      </Card>
    }>
      <LoginForm />
    </Suspense>
  )
}
