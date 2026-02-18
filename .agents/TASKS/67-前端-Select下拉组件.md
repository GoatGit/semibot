# 任务：新增 Select 组件，替换原生 select 元素

**优先级**: 🟡 P1
**类型**: 前端规范
**预估工时**: 3-4h
**影响范围**: 新增 1 个组件 + 修改 3 个页面

---

## 问题描述

当前 agents（创建/编辑）和 skill-definitions（安装对话框）使用原生 `<select>` 元素。原生 select 在暗色主题下样式突兀（下拉菜单使用系统默认样式，无法自定义），且 `<optgroup>` 在不同浏览器下渲染不一致。

---

## 修复方案

### 新建 `apps/web/components/ui/Select.tsx`

```tsx
interface SelectOption {
  value: string
  label: string
  disabled?: boolean
}

interface SelectGroup {
  label: string
  options: SelectOption[]
}

interface SelectProps {
  value: string
  onChange: (value: string) => void
  options: (SelectOption | SelectGroup)[]
  placeholder?: string
  disabled?: boolean
  error?: boolean
  size?: 'sm' | 'md' | 'lg'
}
```

功能要求：
- 自定义下拉菜单，完全适配暗色/亮色主题
- 支持分组（替代 optgroup）
- 支持搜索过滤（可选）
- 键盘导航（上下箭头、Enter 选择、ESC 关闭）
- 点击外部关闭
- 与 Input 组件视觉风格一致

### 迁移现有 select

1. `agents/page.tsx` — AgentFormModal 模型选择
2. `agents/[agentId]/page.tsx` — 模型选择
3. `skill-definitions/page.tsx` — 安装来源类型选择

---

## 修复清单

- [ ] 创建 `apps/web/components/ui/Select.tsx`
- [ ] 支持单选、分组、placeholder
- [ ] 支持键盘导航
- [ ] 适配暗色/亮色主题
- [ ] 迁移 agents 创建弹窗的模型选择
- [ ] 迁移 agents 编辑页面的模型选择
- [ ] 迁移 skill-definitions 安装对话框的来源选择
- [ ] 验证所有下拉功能正常

---

## 完成标准

- 所有下拉选择使用统一 Select 组件
- 下拉菜单在暗色/亮色主题下显示正常
- 支持键盘导航和分组

---

## 相关文档

- [前端规范](../../.claude/rules/frontend.md)
- [PRD: UI 美化](../PRDS/ui-beautification-design-system.md)
