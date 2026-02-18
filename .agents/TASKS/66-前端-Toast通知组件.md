# 任务：新增 Toast 通知组件，统一反馈机制

**优先级**: 🟡 P1
**类型**: 前端规范
**预估工时**: 2-3h
**影响范围**: 新增 2 个文件 + 修改 3 个页面

---

## 问题描述

当前成功/错误提示方式不统一：

| 页面 | 成功提示 | 错误提示 |
|------|----------|----------|
| agents | 内联绿色 banner（手动消失） | 内联红色 banner |
| mcp | 无 | 内联红色 banner + 关闭按钮 |
| skill-definitions | 无 | 红色 alert 块（无关闭） |

---

## 修复方案

### 新建 Toast 系统

1. `apps/web/components/ui/Toast.tsx` — Toast 组件
2. `apps/web/hooks/useToast.ts` — Toast 状态管理 Hook（或用 Zustand store）

```tsx
interface Toast {
  id: string
  type: 'success' | 'error' | 'warning' | 'info'
  title: string
  description?: string
  duration?: number  // 默认 3000ms
}

// 使用方式
const { toast } = useToast()
toast.success('创建成功')
toast.error('删除失败，请重试')
```

功能要求：
- 右上角堆叠显示
- 自动消失（可配置时长）
- 手动关闭按钮
- 进入/退出动画（slide-in-right + fade-out）
- 最多同时显示 3 条
- 使用设计系统语义颜色

### 迁移现有提示

替换 agents、mcp、skill-definitions 页面的内联 error/success 提示为 Toast。

---

## 修复清单

- [ ] 创建 `apps/web/components/ui/Toast.tsx`
- [ ] 创建 `apps/web/hooks/useToast.ts`（或 `stores/toastStore.ts`）
- [ ] 在根 layout 中挂载 ToastContainer
- [ ] 迁移 agents 页面提示
- [ ] 迁移 mcp 页面提示
- [ ] 迁移 skill-definitions 页面提示
- [ ] 验证多条 Toast 堆叠和自动消失

---

## 完成标准

- 所有操作反馈使用统一 Toast 组件
- Toast 支持 4 种类型，自动消失
- 暗色/亮色主题下显示正常

---

## 相关文档

- [前端规范](../../.claude/rules/frontend.md)
- [PRD: UI 美化](../PRDS/ui-beautification-design-system.md)
