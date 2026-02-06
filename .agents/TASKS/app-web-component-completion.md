## Task: 前端组件补全

**ID:** app-web-component-completion
**Label:** Semibot: 补全缺失的前端组件
**Description:** 实现 ImageView、FileDownload 等未完成组件，补充基础 UI 组件
**Type:** Feature
**Status:** Completed
**Priority:** P1 - High
**Created:** 2026-02-06
**Updated:** 2026-02-06
**PRD:** [Link](../PRDS/app-web-component-completion.md)

---

### Checklist

#### Agent2UI 组件

- [ ] 创建 `components/agent2ui/media/` 目录
- [ ] 实现 `ImageView.tsx` - 图片显示组件
- [ ] 实现 `FileDownload.tsx` - 文件下载组件
- [ ] 更新 `ComponentRegistry.tsx` 注册新组件
- [ ] 移除 TODO 注释

#### 基础 UI 组件

- [ ] 安装 `@headlessui/react` 依赖
- [ ] 创建 `components/ui/Modal.tsx`
- [ ] 创建 `components/ui/Select.tsx`
- [ ] 创建 `components/ui/Checkbox.tsx`
- [ ] 创建 `components/ui/Radio.tsx`
- [ ] 创建 `components/ui/Dropdown.tsx`
- [ ] 创建 `components/ui/Tooltip.tsx`
- [ ] 创建 `components/ui/Tabs.tsx`

#### 测试

- [ ] 测试 ImageView 组件
- [ ] 测试 FileDownload 组件
- [ ] 测试 Modal 组件
- [ ] 测试 Select 组件

### 相关文件

- `apps/web/src/components/agent2ui/media/ImageView.tsx` (新建)
- `apps/web/src/components/agent2ui/media/FileDownload.tsx` (新建)
- `apps/web/src/components/agent2ui/ComponentRegistry.tsx`
- `apps/web/src/components/ui/Modal.tsx` (新建)
- `apps/web/src/components/ui/Select.tsx` (新建)
