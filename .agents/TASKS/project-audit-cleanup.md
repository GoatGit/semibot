# 项目审查清理 - 任务清单

基于全面项目审查的发现，按优先级排列。

---

## P0 - 功能缺失修复

### 任务 1: Agent 列表页添加启用/禁用按钮

**文件**: `apps/web/app/(dashboard)/agents/page.tsx`

**步骤**:
1. 导入 `Power` 图标 from `lucide-react`
2. 添加 `handleToggleActive(agent)` 函数，调用 `apiClient.put('/agents/${id}', { isActive: !isActive })`
3. 在 Agent 卡片按钮区域添加 Power 按钮，根据 `isActive` 状态显示不同颜色
4. 卡片上显示启用/禁用状态 Badge

**参考**: `apps/web/app/(dashboard)/skills/page.tsx` 中的 `handleToggleActive` 实现

**验收标准**:
- [ ] Agent 卡片显示启用/禁用状态
- [ ] 点击 Power 按钮可切换状态
- [ ] 切换后列表自动刷新
- [ ] TypeScript 类型检查通过

---

### 任务 2: Skill 页面添加编辑功能

**文件**: `apps/web/app/(dashboard)/skills/page.tsx`

**步骤**:
1. 添加编辑对话框状态（`showEditDialog`, `editingDefinition`, `editName`, `editDescription`, `editTriggerKeywords`）
2. 添加 `handleEdit(definition)` 函数，打开编辑对话框并填充当前值
3. 添加 `handleSaveEdit()` 函数，调用 `apiClient.put('/skill-definitions/${id}', { name, description, triggerKeywords })`
4. 在技能卡片按钮区域添加编辑按钮（Pencil 图标）
5. 添加编辑对话框 JSX（复用创建对话框的表单字段布局）

**验收标准**:
- [ ] 技能卡片有编辑按钮
- [ ] 点击编辑按钮打开对话框，表单预填当前值
- [ ] 可修改名称、描述、触发词
- [ ] 保存后列表自动刷新
- [ ] TypeScript 类型检查通过

---

## P1 - 遗留代码清理

### 任务 3: 删除旧版 `/skills` 后端路由

**文件**:
- 删除: `apps/api/src/routes/v1/skills.ts`
- 修改: `apps/api/src/routes/v1/index.ts` — 移除 `skillsRouter` 导入和注册

**步骤**:
1. 确认无其他后端代码 import `routes/v1/skills`
2. 从 `index.ts` 移除 `import skillsRouter from './skills'` 和 `router.use('/skills', skillsRouter)`
3. 删除 `skills.ts` 文件
4. 运行 `pnpm --filter api exec tsc --noEmit` 确认无类型错误

**验收标准**:
- [ ] 旧版 skills 路由文件已删除
- [ ] index.ts 不再注册 /skills 路由
- [ ] 后端 TypeScript 类型检查通过

---

### 任务 4: 清理旧版 `useSkill.ts` hook

**文件**:
- 删除: `apps/web/hooks/useSkill.ts`
- 修改: `apps/web/hooks/index.ts` — 移除 `useSkill` 相关导出

**步骤**:
1. 确认 `useSkill.ts`（注意不是 `useSkills.ts`）未被任何页面 import
2. 从 `hooks/index.ts` 移除 `useSkill` 导出（保留 `useSkills`）
3. 删除 `useSkill.ts` 文件
4. 运行前端 TypeScript 类型检查

**注意**: `useSkills.ts` 和 `useMcpServers.ts` 在 `agents/[agentId]/page.tsx` 中使用，不能删除

**验收标准**:
- [ ] `useSkill.ts` 已删除
- [ ] `hooks/index.ts` 已更新
- [ ] 前端 TypeScript 类型检查通过

---

### 任务 5: 删除死代码常量 `MOCK_RESPONSE_DELAY_MS`

**文件**: `apps/web/constants/config.ts`

**步骤**:
1. 删除第 32-33 行的 `MOCK_RESPONSE_DELAY_MS` 常量及其注释
2. 确认无其他文件引用此常量

**验收标准**:
- [ ] 常量已删除
- [ ] 无编译错误

---

## P1 - 补充清理

### 任务 6: 检查并清理旧版 skills 相关的后端 service/repository

**文件**:
- 检查: `apps/api/src/services/skill.service.ts`
- 检查: `apps/api/src/repositories/skill.repository.ts`

**步骤**:
1. 确认旧版 skill service 和 repository 是否仍被其他代码引用
2. 如果仅被已删除的 `routes/v1/skills.ts` 引用，则一并删除
3. 如果被其他代码引用（如 runtime），则保留并标注

**验收标准**:
- [ ] 确认依赖关系
- [ ] 无用代码已清理
- [ ] TypeScript 类型检查通过

---

## 验收测试

### 任务 7: 全面验收

**步骤**:
1. 运行后端 TypeScript 类型检查: `pnpm --filter api exec tsc --noEmit`
2. 运行前端 TypeScript 类型检查: `pnpm --filter web exec tsc --noEmit`
3. ���认 `/agents` 页面启用/禁用功能正常
4. 确认 `/skills` 页面编辑功能正常
5. 确认删除的路由和 hook 不影响现有功能

---

## 依赖关系

```
任务 1 (Agent 启用/禁用) — 独立
任务 2 (Skill 编辑) — 独立
任务 3 (删除旧 skills 路由) → 任务 6 (检查 service/repo 依赖)
任务 4 (删除 useSkill hook) — 独立
任务 5 (删除死代码常量) — 独立
任务 7 (验收) — 依赖所有其他任务完成
```

## 备注

以下 hooks 虽然当前未被页面使用，但**暂不删除**，因为对应的后端 API 已完整实现，未来可能创建管理页面：
- `useTool.ts` — 对应 `/tools/*` API
- `useMemory.ts` — 对应 `/memory/*` API
- `useLogs.ts` — 对应 `/logs/*` API
- `useOrganization.ts` — 对应 `/organizations/*` API
- `useMcp.ts` — 对应 `/mcp/*` API（MCP 页面直接用 apiClient）
- `useSession.ts` — 对应 `/sessions/*` API（Chat 页面直接用 apiClient）
- `useSkillDefinitions.ts` — 对应 `/skill-definitions/*` API（Skills 页面直接用 apiClient）
- `useAgent.ts` — 对应 `/agents/:id` API（Agent 详情页直接用 apiClient）
