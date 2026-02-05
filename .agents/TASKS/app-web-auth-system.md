## Task: 前端认证系统

**ID:** app-web-auth-system
**Label:** Semibot: 实现前端认证系统
**Description:** 添加登录/注册页面、路由守卫、Token 管理
**Type:** Feature
**Status:** Pending
**Priority:** P0 - Critical
**Created:** 2026-02-06
**Updated:** 2026-02-06
**PRD:** [Link](../PRDS/app-web-auth-system.md)

---

### Checklist

- [ ] 创建 `stores/authStore.ts` 认证状态管理
- [ ] 创建 `middleware.ts` 路由守卫
- [ ] 创建 `app/(auth)/layout.tsx` 认证页面布局
- [ ] 创建 `app/(auth)/login/page.tsx` 登录页
- [ ] 创建 `app/(auth)/register/page.tsx` 注册页
- [ ] 创建 `app/(auth)/forgot-password/page.tsx` 忘记密码
- [ ] 实现 JWT Token 存储和刷新
- [ ] 配置 API 请求拦截器添加 Authorization header
- [ ] 实现 401 响应自动跳转登录
- [ ] 实现"记住我"功能
- [ ] 添加登出功能
- [ ] 编写单元测试
- [ ] 编写 E2E 测试 (登录流程)

### 相关文件

- `apps/web/src/stores/authStore.ts` (新建)
- `apps/web/src/middleware.ts` (新建)
- `apps/web/src/app/(auth)/*` (新建)
- `apps/web/src/lib/api.ts`
