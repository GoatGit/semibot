# 项目审查清理 PRD

## 背景

对整个项目进行全面审查后，发现以下几类问题：

1. **后端有大量 API 路由在前端未使用** — 包括 runtime、memory、tools、logs、organizations 等整套 API，以及已废弃的旧版 `/skills` 路由
2. **前端有大量 hooks 未被任何页面使用** — 大部分页面直接调用 `apiClient` 而非使用封装的 hooks
3. **Agent/Skill/MCP 前端功能不完整** — Agent 缺少启用/禁用按钮，Skill 缺少编辑功能
4. **存在死代码** — `MOCK_RESPONSE_DELAY_MS` 常量定义但未引用，旧版 skills 路由和 hook 应删除

## 目标

1. 补齐 Agent/Skill/MCP 前端核心功能缺失
2. 清理遗留代码（旧版 skills 路由、未使用的 hooks、死代码常量）
3. 统一前端数据获取模式（页面直接调用 apiClient vs 使用 hooks）

## 功能范围

### P0 - 功能缺失修复

#### 1. Agent 启用/禁用按钮
- **现状**: 后端 `PUT /agents/:id` 支持 `isActive` 字段，前端 agents 列表页无切换按钮
- **目标**: 在 `/agents` 页面的 Agent 卡片上添加启用/禁用切换按钮
- **参考**: `/skills` 页面的 Power 按钮实现

#### 2. Skill 编辑功能
- **现状**: 后端 `PUT /skill-definitions/:id` 支持修改 name/description/triggerKeywords，前端无编辑 UI
- **目标**: 在 `/skills` 页面添加编辑对话框，支持修改名称、描述、触发词

### P1 - 遗留代码清理

#### 3. 删除旧版 `/skills` 后端路由
- **现状**: `apps/api/src/routes/v1/skills.ts` 操作旧 `skills` 表，已被 `/skill-definitions` 完全替代
- **目标**: 删除路由文件，从 `routes/v1/index.ts` 移除注册
- **注意**: 需确认无其他代码依赖此路由

#### 4. 清理未使用的前端 hooks
- **现状**: 以下 hooks 未被任何页面组件使用：
  - `useSkill.ts` ��� 调用旧 `/skills` API，必须删除
  - `useTool.ts` — 无 Tools 管理页面
  - `useMemory.ts` — 无 Memory 管理页面
  - `useLogs.ts` — 无日志/用量页面
  - `useOrganization.ts` — 无组织管理页面
  - `useMcp.ts` — MCP 页面直接调用 apiClient
  - `useSession.ts` — Chat 页面直接调用 apiClient
  - `useSkillDefinitions.ts` — Skills 页面直接调用 apiClient
  - `useAgent.ts` — Agent 详情页直接调用 apiClient
- **策略**:
  - `useSkill.ts` 直接删除（调用已废弃 API）
  - 其余 hooks 保留但标记为 unused（未来可能创建对应管理页面时使用）
  - 更新 `hooks/index.ts` 移除对已删除 hook 的导出

#### 5. 清理死代码常量
- **现状**: `apps/web/constants/config.ts` 中 `MOCK_RESPONSE_DELAY_MS = 1500` 未被任何代码引用
- **目标**: 删除该常量

### P2 - 未来规划（不在本次范围）

以下后端 API 已实现但前端无管理页面，记录备查：
- `/tools/*` — Tools 管理（CRUD）
- `/memory/*` — Memory 管理（CRUD + 向量搜索）
- `/logs/*` — 执行日志和用量统计
- `/organizations/*` — 组织管理
- `/runtime/*` — Runtime 监控
- `/sessions/*` — 会话管理（Chat 页面部分使用）

## 技术方案

### Agent 启用/禁用
- 在 `agents/page.tsx` 添加 `handleToggleActive` 函数
- 调用 `apiClient.put('/agents/:id', { isActive: !agent.isActive })`
- 在 Agent 卡片按钮区域添加 Power 图标按钮

### Skill 编辑
- 在 `skills/page.tsx` 添加编辑对话框状态
- 复用创建对话框的表单字段（name, description, triggerKeywords）
- 调用 `apiClient.put('/skill-definitions/:id', { ... })`

### 旧版 skills 路由删除
- 删除 `apps/api/src/routes/v1/skills.ts`
- 从 `apps/api/src/routes/v1/index.ts` 移除 `router.use('/skills', skillsRouter)`
- 检查是否有其他文件 import 此路由

### Hook 清理
- 删除 `apps/web/hooks/useSkill.ts`
- 更新 `apps/web/hooks/index.ts` 移除 `useSkill` 导出
