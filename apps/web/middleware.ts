import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { AUTH_DISABLED } from './lib/auth-mode'

/**
 * V2 单用户无鉴权中间件
 *
 * 功能：
 * - 兼容旧 auth 路由（/login /register /forgot-password），统一重定向到 dashboard
 * - 其他路由直接放行
 */

const PUBLIC_ROUTES = ['/login', '/register', '/forgot-password']
const HOME_PATH = '/dashboard'

// 静态资源路径
const STATIC_PATHS = ['/_next', '/api', '/favicon.ico', '/images', '/fonts']

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl

  if (STATIC_PATHS.some((path) => pathname.startsWith(path))) {
    return NextResponse.next()
  }

  const isPublicRoute = PUBLIC_ROUTES.some((route) => pathname.startsWith(route))

  // 即使误配置启用了 auth，V2 前端仍保持无鉴权语义
  if (AUTH_DISABLED && isPublicRoute) {
    return NextResponse.redirect(new URL(HOME_PATH, request.url))
  }
  if (isPublicRoute) {
    return NextResponse.redirect(new URL(HOME_PATH, request.url))
  }

  return NextResponse.next()
}

export const config = {
  matcher: [
    /*
     * 匹配所有路径，除了:
     * - api (API 路由)
     * - _next/static (静态文件)
     * - _next/image (图片优化)
     * - favicon.ico (favicon)
     */
    '/((?!api|_next/static|_next/image|favicon.ico).*)',
  ],
}
