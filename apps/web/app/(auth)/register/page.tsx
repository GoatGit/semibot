'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import clsx from 'clsx'
import { Mail, Lock, Eye, EyeOff, User, Building2, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Card, CardContent } from '@/components/ui/Card'
import { useAuthStore } from '@/stores/authStore'
import { apiClient } from '@/lib/api'
import { PASSWORD_LENGTH, USERNAME_LENGTH } from '@/constants/config'

interface RegisterResponse {
  success: boolean
  data: {
    user: {
      id: string
      email: string
      name: string
      role: 'owner' | 'admin' | 'member'
    }
    organization: {
      id: string
      name: string
    }
    token: string
    refresh_token: string
    expires_at: string
  }
  error?: {
    code: string
    message: string
    details?: Array<{ field: string; message: string }>
  }
}

/**
 * 注册页面
 */
export default function RegisterPage() {
  const router = useRouter()
  const { login, setLoading, setError, isLoading, error } = useAuthStore()

  const [formData, setFormData] = useState({
    name: '',
    email: '',
    password: '',
    confirmPassword: '',
    orgName: '',
  })
  const [showPassword, setShowPassword] = useState(false)
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})

  const updateField = (field: string, value: string) => {
    setFormData((prev) => ({ ...prev, [field]: value }))
    // 清除该字段的错误
    if (fieldErrors[field]) {
      setFieldErrors((prev) => {
        const updated = { ...prev }
        delete updated[field]
        return updated
      })
    }
  }

  const validateForm = (): boolean => {
    const errors: Record<string, string> = {}

    if (!formData.name.trim()) {
      errors.name = '请输入姓名'
    } else if (formData.name.length < USERNAME_LENGTH.MIN) {
      errors.name = `姓名至少 ${USERNAME_LENGTH.MIN} 个字符`
    }

    if (!formData.email.trim()) {
      errors.email = '请输入邮箱'
    } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(formData.email)) {
      errors.email = '邮箱格式不正确'
    }

    if (!formData.password) {
      errors.password = '请输入密码'
    } else if (formData.password.length < PASSWORD_LENGTH.MIN) {
      errors.password = `密码至少 ${PASSWORD_LENGTH.MIN} 位`
    }

    if (formData.password !== formData.confirmPassword) {
      errors.confirmPassword = '两次输入的密码不一致'
    }

    if (!formData.orgName.trim()) {
      errors.orgName = '请输入组织名称'
    }

    setFieldErrors(errors)
    return Object.keys(errors).length === 0
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()

    if (!validateForm()) {
      return
    }

    setLoading(true)

    try {
      const response = await apiClient.post<RegisterResponse>('/auth/register', {
        name: formData.name.trim(),
        email: formData.email.trim(),
        password: formData.password,
        org_name: formData.orgName.trim(),
      })

      if (response.success && response.data) {
        const { user, organization, token, refresh_token, expires_at } = response.data

        // 存储到 cookie
        if (typeof document !== 'undefined') {
          document.cookie = `auth_token=${token}; path=/; max-age=${24 * 60 * 60}; samesite=strict`
        }

        // 更新 store
        login(
          {
            id: user.id,
            email: user.email,
            name: user.name,
            role: user.role,
            orgId: organization.id,
            orgName: organization.name,
          },
          {
            accessToken: token,
            refreshToken: refresh_token,
            expiresAt: expires_at,
          }
        )

        // 跳转到首页
        router.push('/')
      } else {
        // 处理字段级错误
        if (response.error?.details) {
          const errors: Record<string, string> = {}
          response.error.details.forEach((detail) => {
            errors[detail.field] = detail.message
          })
          setFieldErrors(errors)
        }
        setError(response.error?.message || '注册失败')
      }
    } catch (err) {
      console.error('[Register] 注册失败:', err)
      setError('网络错误，请稍后重试')
    }
  }

  return (
    <Card>
      <CardContent>
        <h2 className="text-xl font-semibold text-text-primary text-center mb-6">
          创建账户
        </h2>

        <form onSubmit={handleSubmit} className="space-y-4">
          {/* 错误提示 */}
          {error && (
            <div className="p-3 rounded-md bg-error-500/10 border border-error-500/20">
              <p className="text-sm text-error-500">{error}</p>
            </div>
          )}

          {/* 姓名 */}
          <div>
            <label className="block text-sm font-medium text-text-secondary mb-1.5">
              姓名 <span className="text-error-500">*</span>
            </label>
            <Input
              type="text"
              placeholder="请输入姓名"
              value={formData.name}
              onChange={(e) => updateField('name', e.target.value)}
              leftIcon={<User size={16} />}
              disabled={isLoading}
              className={fieldErrors.name ? 'border-error-500' : ''}
            />
            {fieldErrors.name && (
              <p className="text-xs text-error-500 mt-1">{fieldErrors.name}</p>
            )}
          </div>

          {/* 邮箱 */}
          <div>
            <label className="block text-sm font-medium text-text-secondary mb-1.5">
              邮箱 <span className="text-error-500">*</span>
            </label>
            <Input
              type="email"
              placeholder="请输入邮箱"
              value={formData.email}
              onChange={(e) => updateField('email', e.target.value)}
              leftIcon={<Mail size={16} />}
              disabled={isLoading}
              className={fieldErrors.email ? 'border-error-500' : ''}
            />
            {fieldErrors.email && (
              <p className="text-xs text-error-500 mt-1">{fieldErrors.email}</p>
            )}
          </div>

          {/* 密码 */}
          <div>
            <label className="block text-sm font-medium text-text-secondary mb-1.5">
              密码 <span className="text-error-500">*</span>
            </label>
            <div className="relative">
              <Input
                type={showPassword ? 'text' : 'password'}
                placeholder={`至少 ${PASSWORD_LENGTH.MIN} 位`}
                value={formData.password}
                onChange={(e) => updateField('password', e.target.value)}
                leftIcon={<Lock size={16} />}
                disabled={isLoading}
                className={fieldErrors.password ? 'border-error-500' : ''}
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                className={clsx(
                  'absolute right-3 top-1/2 -translate-y-1/2',
                  'p-1 text-text-tertiary hover:text-text-primary',
                  'transition-colors'
                )}
              >
                {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
            {fieldErrors.password && (
              <p className="text-xs text-error-500 mt-1">{fieldErrors.password}</p>
            )}
          </div>

          {/* 确认密码 */}
          <div>
            <label className="block text-sm font-medium text-text-secondary mb-1.5">
              确认密码 <span className="text-error-500">*</span>
            </label>
            <Input
              type={showPassword ? 'text' : 'password'}
              placeholder="请再次输入密码"
              value={formData.confirmPassword}
              onChange={(e) => updateField('confirmPassword', e.target.value)}
              leftIcon={<Lock size={16} />}
              disabled={isLoading}
              className={fieldErrors.confirmPassword ? 'border-error-500' : ''}
            />
            {fieldErrors.confirmPassword && (
              <p className="text-xs text-error-500 mt-1">{fieldErrors.confirmPassword}</p>
            )}
          </div>

          {/* 组织名称 */}
          <div>
            <label className="block text-sm font-medium text-text-secondary mb-1.5">
              组织名称 <span className="text-error-500">*</span>
            </label>
            <Input
              type="text"
              placeholder="请输入组织/团队名称"
              value={formData.orgName}
              onChange={(e) => updateField('orgName', e.target.value)}
              leftIcon={<Building2 size={16} />}
              disabled={isLoading}
              className={fieldErrors.orgName ? 'border-error-500' : ''}
            />
            {fieldErrors.orgName && (
              <p className="text-xs text-error-500 mt-1">{fieldErrors.orgName}</p>
            )}
          </div>

          {/* 注册按钮 */}
          <Button type="submit" className="w-full" disabled={isLoading}>
            {isLoading ? (
              <>
                <Loader2 size={16} className="animate-spin mr-2" />
                注册中...
              </>
            ) : (
              '注册'
            )}
          </Button>
        </form>

        {/* 登录链接 */}
        <p className="text-sm text-text-secondary text-center mt-6">
          已有账户？{' '}
          <Link
            href="/login"
            className="text-primary-400 hover:text-primary-300 transition-colors"
          >
            立即登录
          </Link>
        </p>
      </CardContent>
    </Card>
  )
}
