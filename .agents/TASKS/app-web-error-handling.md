## Task: 前端错误处理完善

**ID:** app-web-error-handling
**Label:** Semibot: 完善前端错误处理机制
**Description:** 添加 loading/error 组件、错误边界、统一 API 错误处理
**Type:** Enhancement
**Status:** Completed
**Priority:** P1 - High
**Created:** 2026-02-06
**Updated:** 2026-02-06
**PRD:** [Link](../PRDS/app-web-error-handling.md)

---

### Checklist

- [ ] 创建 `app/(dashboard)/loading.tsx`
- [ ] 创建 `app/(dashboard)/error.tsx`
- [ ] 创建 `app/error.tsx` (根级错误边界)
- [ ] 创建 `components/ErrorBoundary.tsx` 通用错误边界
- [ ] 安装 `react-hot-toast` 依赖
- [ ] 创建 `components/Toast.tsx` Toast 提供者
- [ ] 在 `layout.tsx` 中添加 ToastProvider
- [ ] 创建 `lib/errorHandler.ts` 错误处理工具
- [ ] 定义 `ERROR_MESSAGES` 本地化消息
- [ ] 配置 API 响应拦截器
- [ ] 401 错误自动跳转登录
- [ ] 开发环境显示详细错误信息
- [ ] 编写单元测试

### 相关文件

- `apps/web/src/app/(dashboard)/loading.tsx` (新建)
- `apps/web/src/app/(dashboard)/error.tsx` (新建)
- `apps/web/src/app/error.tsx` (新建)
- `apps/web/src/components/ErrorBoundary.tsx` (新建)
- `apps/web/src/components/Toast.tsx` (新建)
- `apps/web/src/lib/errorHandler.ts` (新建)
- `apps/web/src/lib/api.ts`
