## Task: 首页 Mock 数据替换为真实 Chat 页面

**ID:** homepage-mock-to-real-chat
**Label:** Semibot: 首页 Mock 替换为真实 Chat
**Description:** 将首页硬编码 mock 数据全部替换为真实 Chat 功能，NavBar 会话列表接入真实 API
**Type:** Frontend Refactor
**Status:** Done
**Priority:** P1
**Created:** 2026-02-10
**Updated:** 2026-02-10
**PRD:** `homepage-mock-to-real-chat.md`

---

### 任务 1：首页路由重定向

**文件:** `apps/web/app/page.tsx`
**状态:** ✅ 已完成

- [x] 将首页从渲染 AppShell + NavBar + Sidebar + DetailCanvas 改为重定向到 `/chat/new`
- [x] 使用 Next.js `redirect()` 实现服务端重定向
- [x] 移除对 `AppShell`、`NavBar`、`Sidebar`、`DetailCanvas` 的 import

**依赖:** 无

---

### 任务 2：NavBar 会话列表接入真实数据

**文件:** `apps/web/components/layout/NavBar.tsx`
**状态:** ✅ 已完成

- [x] 引入 `apiClient` 和相关类型 `ApiResponse`, `Session`
- [x] 添加 `sessions` 状态（`Session[]`）、`isLoadingSessions` 状态
- [x] 在 `useEffect` 中调用 `apiClient.get<ApiResponse<Session[]>>('/sessions')` 加载最近会话
- [x] 限制展示数量（最近 10 条），通过 `NAVBAR_SESSION_LIMIT` 常量控制
- [x] 替换硬编码的 3 条 mock 会话
- [x] `SessionItem` 组件改为接收 `Session` 对象，展示 `session.title` 和格式化时间
- [x] `SessionItem` 的 `href` 改为 `/chat/${session.id}`
- [x] 加载中状态：展示 skeleton 占位
- [x] 空状态：展示"暂无会话"提示
- [x] 当前会话高亮（`active` prop）
- [x] 加载失败时静默处理

**依赖:** 后端 `GET /api/v1/sessions` 已实现

---

### 任务 3：清理 Sidebar mock 内容

**文件:** `apps/web/components/layout/Sidebar.tsx`
**状态:** ✅ 已完成（已删除）

- [x] 全局搜索确认 `Sidebar` 组件无其他引用
- [x] 删除整个 `Sidebar.tsx` 文件

**依赖:** 任务 1 完成后确认引用关系

---

### 任务 4：清理 DetailCanvas mock 内容

**文件:** `apps/web/components/layout/DetailCanvas.tsx`
**状态:** ✅ 已完成

- [x] 移除 `DetailContent` 中硬编码的销售数据表格
- [x] 移除 `DetailContent` 中硬��码的分析报告
- [x] 移除 `DetailHeader` 中硬编码的标题和时间
- [x] `DetailContent` 改为空状态展示（FileText 图标 + "暂无内容"）
- [x] `DetailHeader` 标题改为通用的"详情"
- [x] 保留 DetailCanvas 的折叠/展开/最大化框架功能
- [x] 移除 `DetailFooter`（下载/分享/打印按钮，无真实功能）

**依赖:** 无

---

### 任务 5：验证与回归测试

**状态:** ✅ 已完成

- [x] 运行 `tsc --noEmit` 确认修改文件无新增类型错误
- [x] 验证 `app/page.tsx` 正确使用 `redirect('/chat/new')`
- [x] 验证 NavBar 会话列表代码正确（API 调用、skeleton、空状态、active 高亮）
- [x] 验证 DetailCanvas 无 mock 数据残留
- [x] 验证 Sidebar.tsx 已删除且无残留引用

**依赖:** 任务 1-4 全部完成

---

### 验收标准

- [x] 访问 `/` 自动跳转到 `/chat/new`
- [x] NavBar 会话列表展示真实会话数据（从 API 加载）
- [x] NavBar 点击会话可跳转到对应会话详情页
- [x] NavBar 无会话时显示空状态
- [x] Sidebar 和 DetailCanvas 中无硬编码 mock 数据
- [x] 所有现有 Chat 功能不受影响
- [x] 修改文件无新增 TypeScript 类型错误
- [x] 其他页面不受影响
