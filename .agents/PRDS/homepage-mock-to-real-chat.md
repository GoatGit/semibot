# PRD: 首页 Mock 数据替换为真实 Chat 页面

## 概述

| 字段 | 值 |
|------|-----|
| **功能名称** | 首页 Mock 替换为真实 Chat |
| **版本** | 1.0 |
| **优先级** | P1 |
| **关联任务** | [TASK](../TASKS/homepage-mock-to-real-chat.md) |
| **创建时间** | 2026-02-10 |

## 背景

当前首页 (`app/page.tsx`) 使用独立的三栏布局，所有内容均为硬编码 mock 数据：

| 组件 | Mock 内容 | 文件 |
|------|-----------|------|
| **NavBar** | 硬编码会话列表（"销售数据分析"等 3 条） | `components/layout/NavBar.tsx` |
| **Sidebar** | 硬编码执行计划步骤（分析→规划→执行→观察→总结）、工具调用（web_search、code_executor）、对话消息 | `components/layout/Sidebar.tsx` |
| **DetailCanvas** | 硬编码销售数据分析报告（数据表格 + 分析结论） | `components/layout/DetailCanvas.tsx` |

与此同时，项目已有完整的真实 Chat 实现：

| 页面 | 功能 | 文件 |
|------|------|------|
| `/chat` | 会话列表（调用 `/sessions` API） | `app/(dashboard)/chat/page.tsx` |
| `/chat/new` | 新建会话（调用 `/agents` API + `/chat/start` SSE） | `app/(dashboard)/chat/new/page.tsx` |
| `/chat/[sessionId]` | 会话详情（SSE 流式对话 + 历史消息加载） | `app/(dashboard)/chat/[sessionId]/page.tsx` |

支撑设施：
- `useChat` hook — SSE 连接 + Agent2UI 消息处理
- `useSession` hook — 会话 CRUD（列表/创建/选择/删除/消息加载）
- `sessionStore` — Zustand 会话状态管理
- `useAgent2UI` hook — Agent2UI 协议消息状态
- `useSSE` hook — SSE 流式连接

## 目标

1. **首页直接展示真实 Chat 功能**：用户进入首页即可看到会话列表和开始对话
2. **NavBar 会话列表使用真实数据**：从 `/sessions` API 加载最近会话
3. **移除所有 mock 组件**：Sidebar、DetailCanvas 中的硬编码内容全部移除
4. **首页路由整合**：首页 (`/`) 重定向到 `/chat/new` 或直接内嵌 Chat 功能

## 非目标

- 不重新设计 Chat 页面的 UI（复用现有实现）
- 不改动后端 API
- 不改动 Dashboard 布局框架（AppShell 三栏结构保留，但内容替换）
- 不改动 agents、skills、mcp、settings 等其他页面

## 方案设计

### 方案 A：首页重定向到 /chat/new（推荐）

将 `app/page.tsx` 改为重定向到 `/chat/new`，用户进入首页直接看到新建会话页面。

**优点：**
- 改动最小，复用现有 `/chat/new` 页面
- 路由清晰，无重复代码
- `/chat/new` 已有完整的 Agent 选择 + 快速开始功能

**缺点：**
- URL 从 `/` 变为 `/chat/new`

### 方案 B：首页内嵌 Chat 功能

将 `app/page.tsx` 改为直接渲染 Chat 相关组件（会话列表 + 新建会话入口）。

**优点：**
- URL 保持 `/`
- 可定制首页特有内容（如欢迎语、快捷入口）

**缺点：**
- 需要额外开发首页专属组件
- 与 `/chat/new` 功能重复

### 建议采用方案 A

## 关键需求

### 1. 首页路由重定向

- `app/page.tsx` 改为重定向到 `/chat/new`
- 保持 Dashboard 布局不变

### 2. NavBar 会话列表真实化

当前 NavBar 中硬编码了 3 条 mock 会话，需替换为真实数据：

- 调用 `useSession` hook 或直接调用 `/sessions` API 加载最近会话
- 展示最近 N 条会话（标题 + 时间）
- 点击会话跳转到 `/chat/[sessionId]`
- 无会话时显示空状态提示
- 加载中显示 skeleton

### 3. 清理 Mock 组件

以下组件中的 mock 内容需要清理：

| 组件 | 处理方式 |
|------|----------|
| `Sidebar.tsx` | 移除硬编码的 ProcessArea（执行计划、工具调用）和 ChatArea（mock 消息），改为空状态或移除整个文件 |
| `DetailCanvas.tsx` | 移除硬编码的销售数据报告，DetailCanvas 保留框架但内容由真实数据驱动（当前无内容时已自动折叠） |

### 4. 布局适配

- 首页进入 `/chat/new` 后，NavBar 应收起（非首页行为）
- DetailCanvas 默认折叠（无内容时已自动折叠，无需改动）

## 涉及文件

### 修改
- `apps/web/app/page.tsx` — 改为重定向
- `apps/web/components/layout/NavBar.tsx` — 会话列表真实化
- `apps/web/components/layout/Sidebar.tsx` — 清理 mock 内容
- `apps/web/components/layout/DetailCanvas.tsx` — 清理 mock 内容

### 可能删除
- `apps/web/components/layout/Sidebar.tsx` — 如果首页重定向后不再使用

### 不改动
- `apps/web/components/layout/AppShell.tsx` — 布局框架保留
- `apps/web/app/(dashboard)/layout.tsx` — Dashboard 布局保留
- `apps/web/app/(dashboard)/chat/**` — 已有真实实现，不改动
- `apps/web/hooks/useChat.ts` — 已有真实实现
- `apps/web/hooks/useSession.ts` — 已有真实实现
- `apps/web/stores/sessionStore.ts` — 已有真实实现

## 验收标准

- [ ] 访问 `/` 自动跳转到 `/chat/new`
- [ ] NavBar 会话列表展示真实会话数据（从 API 加载）
- [ ] NavBar 点击会话可跳转到对应会话详情页
- [ ] NavBar 无会话时显示空状态
- [ ] Sidebar 和 DetailCanvas 中无硬编码 mock 数据
- [ ] 所有现有 Chat 功能正常（新建会话、发送消息、SSE 流式响应）
- [ ] TypeScript 类型检查通过
- [ ] 其他页面（agents、skills、mcp、settings）不受影响
