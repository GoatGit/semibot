# PRD: UI 美化 — 设计系统一致性与组件补全

## 背景

当前前端已建立了完整的 CSS 变量设计系统（Design Tokens），包括语义化颜色、间距、圆角、阴影、动画等。但部分页面和组件仍使用硬编码 Tailwind 颜色（如 `text-gray-900`、`bg-white`），导致暗色主题下显示异常，且各页面风格不统一。同时缺少 Modal、Toast、Tooltip、Select 等通用组件，各页面重复实现弹窗逻辑。

## 问题清单

### P0 — 暗色主题兼容性

1. **Badge 组件硬编码颜色** — 使用 `bg-gray-100`、`text-gray-800` 等，暗色主题下几乎不可见
2. **技能管理页面（skill-definitions）全页面硬编码** — `text-gray-900`、`bg-white`、`text-gray-600`、`bg-red-50`、`border-red-200` 等，暗色主题完全不可用
3. **技能管理页面弹窗使用 `bg-white`** — 暗色主题下弹窗白底刺眼

### P1 — 组件缺失与重复实现

4. **无通用 Modal 组件** — agents、mcp、skill-definitions 三个页面各自实现弹窗，样式和交互不一致（有的有 backdrop 点击关闭，有的没有；有的有 ESC 关闭，有的没有）
5. **无 Toast/通知组件** — 成功/错误提示方式不统一：agents 用内联 banner、skill-definitions 用红色 alert、mcp 用可关闭 banner
6. **无 Tooltip 组件** — 图标按钮（编辑、删除、开关）缺少 hover 提示，可访问性不足
7. **原生 `<select>` 未适配主题** — agents 和 skill-definitions 页面的下拉框在暗色主题下样式突兀

### P2 — 视觉一致性

8. **页面头部布局不统一** — agents/mcp 使用 `header` + `border-b` 结构，skill-definitions 使用 `div` + `space-y-6`
9. **空状态设计不统一** — agents 有精心设计的 EmptyState 组件，skill-definitions 只有一行文字
10. **加载状态不统一** — agents 用 Loader2 图标，skill-definitions 用 border-spinner + 蓝色硬编码

## 影响范围

- `apps/web/components/ui/Badge.tsx`
- `apps/web/app/(dashboard)/skill-definitions/page.tsx`
- `apps/web/app/(dashboard)/agents/page.tsx`
- `apps/web/app/(dashboard)/agents/[agentId]/page.tsx`
- `apps/web/app/(dashboard)/mcp/page.tsx`
- `apps/web/components/ui/` — 新增 Modal、Toast、Tooltip、Select 组件

## 优先级

- P0: Badge 修复 + skill-definitions 页面主题适配（暗色主题不可用是阻塞性问题）
- P1: 通用组件抽取（Modal、Toast、Tooltip、Select）
- P2: 页面布局和空状态统一

## 验收标准

- [ ] 所有页面在暗色/亮色主题下显示正常，无硬编码颜色
- [ ] Badge 组件使用设计系统 CSS 变量
- [ ] 通用 Modal 组件支持 backdrop 点击关闭、ESC 关闭、动画过渡
- [ ] 所有弹窗统一使用 Modal 组件
- [ ] Toast 组件支持 success/error/warning/info 四种类型，自动消失
- [ ] 原生 select 替换为主题适配的 Select 组件
- [ ] 所有图标按钮有 Tooltip 提示
- [ ] 页面头部、空状态、加载状态风格统一

## 相关文件

- `apps/web/app/globals.css` — 设计系统 CSS 变量定义
- `apps/web/tailwind.config.ts` — Tailwind 扩展配置
- `apps/web/components/ui/` — 现有组件库
