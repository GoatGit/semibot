## Task: Skills 页面合并 — 废弃 /skills，统一到 /skill-definitions

**ID:** skills-page-consolidation
**Label:** Semibot: Skills 页面合并
**Description:** 废弃遗留 /skills 页面，将缺失功能合并到 /skill-definitions，统一技能管理入口
**Type:** Frontend Refactor
**Status:** Ready
**Priority:** P1
**Created:** 2026-02-10
**Updated:** 2026-02-10
**PRD:** `skills-page-consolidation.md`

---

### 任务 1：创建对话框补充触发词字段

**文件:** `apps/web/app/(dashboard)/skill-definitions/page.tsx`
**状态:** 待开始

- [ ] 添加 `createTriggerKeywords` 状态（string）
- [ ] 创建对话框中添加触发词输入框（逗号分隔，placeholder 参考 /skills 页面）
- [ ] `handleCreate` 中将逗号分隔字符串转为 `string[]`，传入 API 的 `triggerKeywords` 字段
- [ ] 创建成功后重置 `createTriggerKeywords`

**依赖:** 无（后端 `createSkillDefinitionSchema` 和 repository 已支持 `triggerKeywords`）

---

### 任务 2：技能卡片展示触发词

**文件:** `apps/web/app/(dashboard)/skill-definitions/page.tsx`
**状态:** 待开始

- [ ] 在卡片的 tags 区域下方，展示 `definition.triggerKeywords`（如果非空）
- [ ] 样式参考 `/skills` 页面：`触发词：keyword1 / keyword2`
- [ ] 确认 `SkillDefinition` 类型中包含 `triggerKeywords` 字段（shared-types）

**依赖:** 需确��� shared-types 中 SkillDefinition 是否有 triggerKeywords

---

### 任务 3：技能卡片添加删除按钮

**文件:** `apps/web/app/(dashboard)/skill-definitions/page.tsx`
**状态:** 待开始

- [ ] 导入 `Trash2` 图标
- [ ] 在操作按钮区域添加删除按钮（variant="secondary"，红色文字或 hover 变红）
- [ ] 添加 `handleDelete` 函数，调用 `apiClient.delete(/skill-definitions/${id})`
- [ ] 删除前弹出确认提示（可用 `window.confirm` 简单实现）
- [ ] 删除成功后刷新列表

**依赖:** 后端 DELETE `/api/v1/skill-definitions/:id` 已存在

---

### 任务 4：删除 /skills 遗留页面

**文件:** `apps/web/app/(dashboard)/skills/page.tsx`
**状态:** 待开始

- [ ] 删除 `apps/web/app/(dashboard)/skills/page.tsx`
- [ ] 检查是否有其他文件引用 `/skills` 路由或 import 该页面，如有则清理
- [ ] 确认 NavBar 中已无 `/skills` 入口（已确认：当前指向 `/skill-definitions`）

**依赖:** 任务 1-3 完成后执行

---

### 任务 5：TypeScript 类型检查 & 验收

**状态:** 待开始

- [ ] 运行 `tsc --noEmit`（前端 + 后端）确认无类型错误
- [ ] 确认 shared-types 中 `SkillDefinition` 包含 `triggerKeywords` 字段
- [ ] 手动验证：创建技能（含触发词）→ 卡片展示触发词 → 启用/禁用 → 删除

**依赖:** 任务 1-4 全部完成

---

### 任务 6：路由重命名 /skill-definitions → /skills

**状态:** 待开始

- [ ] 将 `apps/web/app/(dashboard)/skill-definitions/` 目录重命名为 `apps/web/app/(dashboard)/skills/`
- [ ] 更新 NavBar 中的 href：`/skill-definitions` → `/skills`
- [ ] 全局搜索前端代码中所有 `/skill-definitions` 引用，统一改为 `/skills`
- [ ] 注意：后端 API 路由 `/api/v1/skill-definitions` 不改（仅改前端页面路由）

**依赖:** 任务 4 完成后（旧 /skills 页面已删除，路径不冲突）

---

### 验收标准

- [ ] `/skills` 页面可创建技能（含触发词）
- [ ] 技能卡片展示触发词
- [ ] `/skills` 页面可删除技能
- [ ] 前端路由已从 `/skill-definitions` 简化为 `/skills`
- [ ] TypeScript 类型检查通过
- [ ] 导航栏只有一个技能管理入口，指向 `/skills`
