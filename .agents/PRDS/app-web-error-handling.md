# PRD: 前端错误处理完善

## 概述

前端缺少全局错误处理机制，组件崩溃会导致白屏，需要完善错误边界和 loading 状态。

## 问题描述

- 缺少 `app/(dashboard)/loading.tsx` - 路由切换无加载指示
- 缺少 `app/(dashboard)/error.tsx` - 错误无法被优雅捕获
- 无全局错误边界
- API 错误无统一拦截
- 错误消息未本地化

## 目标

1. 添加路由级 loading 和 error 组件
2. 实现全局错误边界
3. 统一 API 错误处理
4. 建立错误日志上报机制

## 技术方案

### 1. Loading 组件

```tsx
// app/(dashboard)/loading.tsx
export default function Loading() {
  return (
    <div className="flex items-center justify-center h-full min-h-[400px]">
      <div className="flex flex-col items-center gap-4">
        <div className="animate-spin rounded-full h-12 w-12 border-4 border-primary-500 border-t-transparent" />
        <p className="text-text-secondary">加载中...</p>
      </div>
    </div>
  )
}
```

### 2. Error 组件

```tsx
// app/(dashboard)/error.tsx
'use client'

import { useEffect } from 'react'
import { Button } from '@/components/ui/Button'

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    // 上报错误到监控系统
    console.error('[Error Boundary]', error)
    // TODO: 集成 Sentry
  }, [error])

  return (
    <div className="flex items-center justify-center h-full min-h-[400px]">
      <div className="flex flex-col items-center gap-4 text-center max-w-md">
        <div className="text-6xl">😵</div>
        <h2 className="text-xl font-semibold text-text-primary">
          出了点问题
        </h2>
        <p className="text-text-secondary">
          页面加载时发生错误，请尝试刷新或返回首页
        </p>
        <div className="flex gap-2">
          <Button onClick={reset}>重试</Button>
          <Button variant="secondary" onClick={() => window.location.href = '/'}>
            返回首页
          </Button>
        </div>
        {process.env.NODE_ENV === 'development' && (
          <pre className="mt-4 p-4 bg-surface-secondary rounded text-left text-xs overflow-auto max-w-full">
            {error.message}
          </pre>
        )}
      </div>
    </div>
  )
}
```

### 3. 全局错误边界

```tsx
// components/ErrorBoundary.tsx
'use client'

import { Component, ReactNode } from 'react'

interface Props {
  children: ReactNode
  fallback?: ReactNode
}

interface State {
  hasError: boolean
  error?: Error
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props)
    this.state = { hasError: false }
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error('[ErrorBoundary]', error, errorInfo)
    // TODO: 上报到 Sentry
  }

  render() {
    if (this.state.hasError) {
      return this.props.fallback || (
        <div className="p-4 bg-red-50 border border-red-200 rounded">
          <p className="text-red-600">组件加载失败</p>
          <button
            onClick={() => this.setState({ hasError: false })}
            className="mt-2 text-sm text-primary-500 underline"
          >
            点击重试
          </button>
        </div>
      )
    }

    return this.props.children
  }
}
```

### 4. API 错误处理

```typescript
// lib/api.ts
import axios, { AxiosError } from 'axios'

const ERROR_MESSAGES: Record<string, string> = {
  NETWORK_ERROR: '网络连接失败，请检查网络设置',
  TIMEOUT: '请求超时，请稍后重试',
  UNAUTHORIZED: '登录已过期，请重新登录',
  FORBIDDEN: '没有权限执行此操作',
  NOT_FOUND: '请求的资源不存在',
  RATE_LIMIT_EXCEEDED: '请求过于频繁，请稍后重试',
  SERVER_ERROR: '服务器错误，请稍后重试',
  UNKNOWN: '未知错误，请联系管理员',
}

export function getErrorMessage(error: unknown): string {
  if (axios.isAxiosError(error)) {
    const axiosError = error as AxiosError<{ error?: { code?: string; message?: string } }>

    if (!error.response) {
      return ERROR_MESSAGES.NETWORK_ERROR
    }

    const code = axiosError.response?.data?.error?.code
    if (code && ERROR_MESSAGES[code]) {
      return ERROR_MESSAGES[code]
    }

    const message = axiosError.response?.data?.error?.message
    if (message) {
      return message
    }

    if (axiosError.response?.status === 401) return ERROR_MESSAGES.UNAUTHORIZED
    if (axiosError.response?.status === 403) return ERROR_MESSAGES.FORBIDDEN
    if (axiosError.response?.status === 404) return ERROR_MESSAGES.NOT_FOUND
    if (axiosError.response?.status === 429) return ERROR_MESSAGES.RATE_LIMIT_EXCEEDED
    if (axiosError.response?.status >= 500) return ERROR_MESSAGES.SERVER_ERROR
  }

  return ERROR_MESSAGES.UNKNOWN
}

// 全局错误拦截
apiClient.interceptors.response.use(
  (response) => response,
  (error) => {
    const message = getErrorMessage(error)

    // 显示 toast 通知
    toast.error(message)

    // 401 跳转登录
    if (error.response?.status === 401) {
      window.location.href = '/login'
    }

    return Promise.reject(error)
  }
)
```

### 5. Toast 通知组件

```tsx
// components/Toast.tsx
import { Toaster } from 'react-hot-toast'

export function ToastProvider() {
  return (
    <Toaster
      position="top-right"
      toastOptions={{
        duration: 4000,
        style: {
          background: 'var(--surface-primary)',
          color: 'var(--text-primary)',
          border: '1px solid var(--border-secondary)',
        },
        error: {
          iconTheme: {
            primary: '#ef4444',
            secondary: 'white',
          },
        },
      }}
    />
  )
}
```

## 验收标准

- [ ] 路由切换显示 loading 指示器
- [ ] 页面错误显示友好提示和重试按钮
- [ ] 组件错误不影响其他组件
- [ ] API 错误显示本地化消息
- [ ] 开发环境显示详细错误信息
- [ ] 生产环境隐藏技术细节

## 优先级

**P1 - 高优先级**

## 相关文件

- `apps/web/src/app/(dashboard)/loading.tsx` (新建)
- `apps/web/src/app/(dashboard)/error.tsx` (新建)
- `apps/web/src/components/ErrorBoundary.tsx` (新建)
- `apps/web/src/lib/api.ts`
- `apps/web/src/components/Toast.tsx` (新建)
