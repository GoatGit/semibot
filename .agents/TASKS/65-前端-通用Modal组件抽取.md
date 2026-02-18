# 任务：抽取通用 Modal 组件，统一弹窗实现

**优先级**: 🟡 P1
**类型**: 前端规范
**预估工时**: 3-4h
**影响范围**: 新增 1 个组件 + 修改 3 个页面

---

## 问题描述

当前 agents、mcp、skill-definitions 三个页面各自实现弹窗逻辑，存在以下不一致：

| 页面 | backdrop | ESC 关闭 | 动画 | 背景色 |
|------|----------|----------|------|--------|
| agents | `bg-black/40` | 无 | 无 | `bg-bg-surface` |
| mcp | `bg-black/40` | 无 | 无 | `bg-bg-surface` |
| skill-definitions | `bg-black bg-opacity-50` | 无 | 无 | `bg-white`（硬编码） |

---

## 修复方案

### 新建 `apps/web/components/ui/Modal.tsx`

```tsx
interface ModalProps {
  open: boolean
  onClose: () => void
  title: string
  description?: string
  children: React.ReactNode
  footer?: React.ReactNode
  maxWidth?: 'sm' | 'md' | 'lg'
}
```

功能要求：
- backdrop 点击关闭（可配置）
- ESC 键关闭
- 打开/关闭动画（fade + scale）
- 焦点陷阱（focus trap）
- 阻止背景滚动（body scroll lock）
- 使用设计系统颜色

### 迁移现有弹窗

1. `agents/page.tsx` — AgentFormModal、ConfirmDeleteModal
2. `mcp/page.tsx` — ServerFormModal（创建/编辑）
3. `skill-definitions/page.tsx` — 安装对话框、编辑对话框

---

## 修复清单

- [ ] 创建 `apps/web/components/ui/Modal.tsx`
- [ ] 支持 backdrop 点击关闭
- [ ] 支持 ESC 键关闭
- [ ] 支持 fade + scale 动画
- [ ] 迁移 agents 页面弹窗
- [ ] 迁移 mcp 页面弹窗
- [ ] 迁移 skill-definitions 页面弹窗
- [ ] 验证所有弹窗功能正常

---

## 完成标准

- 所有弹窗使用统一 Modal 组件
- 支持 ESC 关闭和 backdrop 点击关闭
- 打开/关闭有平滑动画
- 暗色/亮色主题下显示正常

---

## 相关文档

- [前端规范](../../.claude/rules/frontend.md)
- [PRD: UI 美化](../PRDS/ui-beautification-design-system.md)
