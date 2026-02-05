# PRD: 前端认证系统

## 概述

当前前端应用完全缺失认证系统，所有页面公开可访问，存在严重安全风险。

## 问题描述

- 没有登录/注册页面
- 没有 token 管理
- 没有路由守卫
- 没有用户状态管理
- 所有功能对任何人开放

## 目标

1. 实现完整的登录/注册流程
2. 集成 JWT token 管理
3. 保护需要认证的路由
4. 实现用户会话管理

## 技术方案

### 1. 认证 Store

```typescript
// stores/authStore.ts
interface AuthState {
  user: User | null
  token: string | null
  isAuthenticated: boolean
  login: (credentials: LoginCredentials) => Promise<void>
  logout: () => void
  refreshToken: () => Promise<void>
}
```

### 2. 路由中间件

```typescript
// middleware.ts
import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

const PUBLIC_PATHS = ['/login', '/register', '/forgot-password']

export function middleware(request: NextRequest) {
  const token = request.cookies.get('auth-token')
  const isPublicPath = PUBLIC_PATHS.some(path =>
    request.nextUrl.pathname.startsWith(path)
  )

  if (!token && !isPublicPath) {
    return NextResponse.redirect(new URL('/login', request.url))
  }

  if (token && isPublicPath) {
    return NextResponse.redirect(new URL('/', request.url))
  }
}

export const config = {
  matcher: ['/((?!api|_next/static|_next/image|favicon.ico).*)'],
}
```

### 3. 新增页面

- `app/(auth)/login/page.tsx` - 登录页
- `app/(auth)/register/page.tsx` - 注册页
- `app/(auth)/forgot-password/page.tsx` - 忘记密码

### 4. API 集成

```typescript
// lib/api.ts
const apiClient = axios.create({
  baseURL: process.env.NEXT_PUBLIC_API_URL,
})

apiClient.interceptors.request.use((config) => {
  const token = getToken()
  if (token) {
    config.headers.Authorization = `Bearer ${token}`
  }
  return config
})

apiClient.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 401) {
      clearToken()
      window.location.href = '/login'
    }
    return Promise.reject(error)
  }
)
```

## 验收标准

- [ ] 登录/注册页面功能正常
- [ ] 未登录用户自动跳转到登录页
- [ ] Token 正确存储和刷新
- [ ] 登出后清除所有用户数据
- [ ] 支持"记住我"功能
- [ ] 密码重置流程完整

## 优先级

**P0 - 阻塞性** - 安全风险

## 相关文件

- `apps/web/src/stores/authStore.ts` (新建)
- `apps/web/src/middleware.ts` (新建)
- `apps/web/src/app/(auth)/*` (新建)
- `apps/web/src/lib/api.ts`
