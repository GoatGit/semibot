# 任务：Badge 组件适配设计系统 + skill-definitions 页面主题修复

**优先级**: 🔴 P0
**类型**: 前端规范
**预估工时**: 2-3h
**影响范围**: 2 个文件

---

## 问题描述

### Badge 组件
`Badge.tsx` 使用硬编码 Tailwind 颜色（`bg-gray-100`、`text-gray-800`、`bg-green-100` 等），未使用项目设计系统的 CSS 变量。暗色主题下 Badge 几乎不可见。

### skill-definitions 页面
整个页面使用 `text-gray-900`、`bg-white`、`text-gray-600`、`bg-red-50` 等硬编码颜色，暗色主题完全不可用。弹窗使用 `bg-white` 白底。加载状态使用 `border-blue-600` 硬编码。

---

## 当前实现

```tsx
// Badge.tsx — 硬编码颜色
const variantStyles = {
  default: 'bg-gray-100 text-gray-800 border-gray-200',
  success: 'bg-green-100 text-green-800 border-green-200',
  warning: 'bg-yellow-100 text-yellow-800 border-yellow-200',
  error: 'bg-red-100 text-red-800 border-red-200',
  outline: 'bg-transparent text-gray-700 border-gray-300',
}

// skill-definitions/page.tsx — 硬编码颜色
<h1 className="text-2xl font-bold text-gray-900">技能管理</h1>
<p className="text-gray-600 mt-1">管理平台技能定义</p>
<div className="bg-white rounded-lg max-w-lg w-full">  // 弹窗白底
```

---

## 修复方案

### 1. Badge 组件改用设计系统变量

```tsx
const variantStyles = {
  default: 'bg-neutral-500/10 text-text-secondary border-border-default',
  success: 'bg-success-500/10 text-success-500 border-success-500/20',
  warning: 'bg-warning-500/10 text-warning-500 border-warning-500/20',
  error: 'bg-error-500/10 text-error-500 border-error-500/20',
  outline: 'bg-transparent text-text-secondary border-border-default',
}
```

### 2. skill-definitions 页面全量替换

| 硬编码 | 替换为 |
|--------|--------|
| `text-gray-900` | `text-text-primary` |
| `text-gray-600` | `text-text-secondary` |
| `text-gray-500` | `text-text-tertiary` |
| `text-gray-400` | `text-text-tertiary` |
| `text-gray-700` | `text-text-secondary` |
| `bg-white` | `bg-bg-surface` |
| `bg-red-50` | `bg-error-500/10` |
| `border-red-200` | `border-error-500/30` |
| `text-red-600/700/800` | `text-error-500` |
| `border-gray-300` | `border-border-default` |
| `border-blue-600` | `border-primary-500` |
| `bg-black bg-opacity-50` | `bg-black/40` |

### 3. 页面布局对齐

将 skill-definitions 页面头部改为与 agents/mcp 一致的 `header` + `border-b` 结构。

---

## 修复清单

- [ ] 修改 `apps/web/components/ui/Badge.tsx` 颜色为设计系统变量
- [ ] 修改 `apps/web/app/(dashboard)/skill-definitions/page.tsx` 所有硬编码颜色
- [ ] 弹窗背景改为 `bg-bg-surface`
- [ ] 加载状态改为 `border-primary-500` + `text-text-secondary`
- [ ] 页面头部改为 `header` + `border-b border-border-subtle` 结构
- [ ] 暗色/亮色主题下视觉验证

---

## 完成标准

- Badge 在暗色/亮色主题下均清晰可读
- skill-definitions 页面无任何硬编码 Tailwind 颜色
- 页面风格与 agents、mcp 页面一致

---

## 相关文档

- [前端规范](../../.claude/rules/frontend.md)
- [PRD: UI 美化](../PRDS/ui-beautification-design-system.md)
