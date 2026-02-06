'use client'

import { useState } from 'react'
import Link from 'next/link'
import { Mail, ArrowLeft, Loader2, CheckCircle } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Card, CardContent } from '@/components/ui/Card'
import { apiClient } from '@/lib/api'

/**
 * 忘记密码页面
 */
export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [isSuccess, setIsSuccess] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()

    if (!email.trim()) {
      setError('请输入邮箱')
      return
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setError('邮箱格式不正确')
      return
    }

    setIsLoading(true)
    setError(null)

    try {
      // TODO: 实际实现时调用 API
      await apiClient.post('/auth/forgot-password', {
        email: email.trim(),
      })

      setIsSuccess(true)
    } catch (err) {
      console.error('[ForgotPassword] 请求失败:', err)
      // 出于安全考虑，即使邮箱不存在也显示成功
      setIsSuccess(true)
    } finally {
      setIsLoading(false)
    }
  }

  // 成功状态
  if (isSuccess) {
    return (
      <Card>
        <CardContent className="text-center py-8">
          <div className="w-16 h-16 rounded-full bg-success-500/20 flex items-center justify-center mx-auto mb-4">
            <CheckCircle size={32} className="text-success-500" />
          </div>
          <h2 className="text-xl font-semibold text-text-primary mb-2">
            邮件已发送
          </h2>
          <p className="text-sm text-text-secondary mb-6">
            如果该邮箱已注册，您将收到一封包含重置密码链接的邮件。
            <br />
            请检查您的收件箱和垃圾邮件文件夹。
          </p>
          <Link href="/login">
            <Button variant="secondary" leftIcon={<ArrowLeft size={16} />}>
              返回登录
            </Button>
          </Link>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card>
      <CardContent>
        <h2 className="text-xl font-semibold text-text-primary text-center mb-2">
          忘记密码
        </h2>
        <p className="text-sm text-text-secondary text-center mb-6">
          输入您的邮箱，我们将发送重置密码链接
        </p>

        <form onSubmit={handleSubmit} className="space-y-4">
          {/* 错误提示 */}
          {error && (
            <div className="p-3 rounded-md bg-error-500/10 border border-error-500/20">
              <p className="text-sm text-error-500">{error}</p>
            </div>
          )}

          {/* 邮箱 */}
          <div>
            <label className="block text-sm font-medium text-text-secondary mb-1.5">
              邮箱
            </label>
            <Input
              type="email"
              placeholder="请输入注册邮箱"
              value={email}
              onChange={(e) => {
                setEmail(e.target.value)
                setError(null)
              }}
              leftIcon={<Mail size={16} />}
              disabled={isLoading}
            />
          </div>

          {/* 提交按钮 */}
          <Button
            type="submit"
            className="w-full"
            disabled={isLoading || !email.trim()}
          >
            {isLoading ? (
              <>
                <Loader2 size={16} className="animate-spin mr-2" />
                发送中...
              </>
            ) : (
              '发送重置链接'
            )}
          </Button>
        </form>

        {/* 返回登录 */}
        <div className="text-center mt-6">
          <Link
            href="/login"
            className="text-sm text-primary-400 hover:text-primary-300 transition-colors inline-flex items-center gap-1"
          >
            <ArrowLeft size={14} />
            返回登录
          </Link>
        </div>
      </CardContent>
    </Card>
  )
}
