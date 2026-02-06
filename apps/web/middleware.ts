import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

/**
 * 路由守卫中间件
 *
 * 功能:
 * - 检查用户认证状态
 * - 未登录用户重定向到登录页
 * - 已登录用户访问登录页重定向到首页
 */

// 公开路由 - 无需认证
const PUBLIC_ROUTES = ['/login', '/register', '/forgot-password']

// 静态资源路径
const STATIC_PATHS = ['/_next', '/api', '/favicon.ico', '/images', '/fonts']

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl

  // 跳过静态资源
  if (STATIC_PATHS.some((path) => pathname.startsWith(path))) {
    return NextResponse.next()
  }

  // 从 cookie 或 header 获取 token
  const token = request.cookies.get('auth_token')?.value

  const isPublicRoute = PUBLIC_ROUTES.some((route) => pathname.startsWith(route))
  const isAuthenticated = !!token

  // 未登录访问受保护页面 -> 重定向到登录页
  if (!isAuthenticated && !isPublicRoute) {
    const loginUrl = new URL('/login', request.url)
    loginUrl.searchParams.set('redirect', pathname)
    return NextResponse.redirect(loginUrl)
  }

  // 已登录访问登录/注册页 -> 重定向到首页
  if (isAuthenticated && isPublicRoute) {
    return NextResponse.redirect(new URL('/', request.url))
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
