# Task: Skills 和 MCP 管理页面

**ID:** skills-mcp-management-pages
**Label:** Web: Skills 和 MCP 管理页面
**Description:** 添加 Skills（技能）和 MCP（Model Context Protocol）服务器管理页面
**Type:** Feature
**Status:** Done
**Priority:** High
**Created:** 2026-02-05
**Updated:** 2026-02-05
**PRD:** [Link](../PRDS/skills-mcp-management-pages.md)

---

## 背景

当前系统缺少 Skills 和 MCP 管理功能的前端页面。用户需要能够：
- 查看、启用/禁用技能
- 管理 MCP 服务器连接
- 配置技能和 MCP 参数

## 实现范围

### 1. Skills 管理页面 (`/skills`)
- 技能列表展示（卡片/列表视图）
- 技能搜索和分类筛选
- 技能启用/禁用切换
- 技能详情查看
- 技能配置编辑

### 2. MCP 管理页面 (`/mcp`)
- MCP 服务器列表
- 服务器连接状态显示
- 添加/编辑/删除 MCP 服务器
- 服务器工具列表展示
- 连接测试功能

## 技术要点

- 复用现有 UI 组件（Button, Input, Card）
- 遵循 `(dashboard)` 路由组结构
- 在 NavBar 添加导航入口
- 使用 lucide-react 图标

## 验收标准

- [x] `/skills` 页面可正常访问
- [x] `/mcp` 页面可正常访问
- [x] 导航栏显示新入口
- [x] 页面风格与现有页面一致
- [x] 响应式布局正常

## 完成记录

**完成日期:** 2026-02-05

### 实现内容

1. **NavBar 更新** (`apps/web/components/layout/NavBar.tsx`)
   - 添加 Skills 导航入口 (Sparkles 图标)
   - 添加 MCP 导航入口 (Puzzle 图标)

2. **MCP 管理页面** (`apps/web/app/(dashboard)/mcp/page.tsx`)
   - 服务器卡片网格展示
   - 搜索和状态筛选（全部/已连接/断开/错误）
   - 连接状态指示器
   - 服务器类型标签（STDIO/SSE/HTTP）
   - 工具列表展示
   - 操作菜单（测试连接、配置、删除）

### 测试验证

- ✅ `/skills` 页面正常加载，显示 6 个技能
- ✅ `/mcp` 页面正常加载，显示 5 个服务器
- ✅ 导航栏显示 Skills 和 MCP 入口
- ✅ 构建成功，无错误
