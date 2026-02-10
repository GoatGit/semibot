# PRD: Skills 页面合并 — 废弃 /skills，统一到 /skill-definitions

## 概述

| 字段 | 值 |
|------|-----|
| **功能名称** | Skills 页面合并 |
| **版本** | 1.0 |
| **优先级** | P1 |
| **关联任务** | [TASK](../TASKS/skills-page-consolidation.md) |
| **创建时间** | 2026-02-10 |

## 背景

当前项目存在两个技能管理页面：

| | `/skills` 页面 | `/skill-definitions` 页面 |
|---|---|---|
| **后端 API** | `/api/v1/skills`（skills 表） | `/api/v1/skill-definitions`（skill_definitions 表） |
| **数据模型** | Skill：name, triggerKeywords, config, isBuiltin | SkillDefinition：skillId, name, currentVersion, triggerKeywords |
| **功能** | 创建自定义技能、安装 Anthropic Skill、启用/禁用、删除 | 创建技能定义、安装版本包、版本历史、回滚、启用/禁用 |

`skill_definitions` + `skill_packages` 是新的两层数据模型，`skills` 是遗留表。当前处于**不完整的迁移状态**：
- 新表已创建并有迁移脚本
- `agent_skills` 已添加 `skill_definition_id` 列
- 但旧表 `skills` 和旧页面 `/skills` 仍在使用

`skills` 表中的字段在新模型中都有对应位置：
- `trigger_keywords` → `skill_definitions.trigger_keywords`（已存在）
- `tools`, `config`（maxExecutionTime, retryAttempts, requiresApproval） → `skill_packages.tools`, `skill_packages.config`（已存在）
- `name`, `description`, `is_active` → `skill_definitions` 中已有

## 目标

1. 废弃 `/skills` 页面，将其功能合并到 `/skill-definitions` 页面
2. `/skill-definitions` 页面补充缺失功能：触发词管理、删除技能
3. 导航栏统一入口
4. 不改动后端数据模型和 API（后端迁移为独立任务）

## 非目标

- 不废弃后端 `/api/v1/skills` API（后续独立任务）
- 不迁移 `skills` 表数据（后续独立任务）
- 不改动 `skill_packages` 的 config 管理（安装时已支持）

## 关键需求

### 1. 创建对话框增强

当前创建对话框仅有：skillId、name、description。

需要补充：
- **触发词**（trigger_keywords）：逗号分隔输入，与 `/skills` 页面一致
- 后端 `createSkillDefinitionSchema` 和 repository 已支持 `triggerKeywords`，无需后端改动

### 2. 技能卡片增强

当前卡片有：名称、skillId、描述、版本、分类、标签、版本按钮、安装按钮、启用/禁用按钮。

需要补充：
- **触发词显示**：卡片上展示 triggerKeywords
- **删除按钮**：调用后端 DELETE API

### 3. 导航栏统一

- 移除 `/skills` 导航入口（如果还存在）
- 保留 `/skill-definitions` 入口，显示名称改为"技能管理"

### 4. 废弃 /skills 页面

- 删除 `apps/web/app/(dashboard)/skills/page.tsx`
- 如有其他地方引用 `/skills` 路由，统一改为 `/skill-definitions`

## 涉及文件

### 前端修改
- `apps/web/app/(dashboard)/skill-definitions/page.tsx` — 创建对话框增强、卡片增强、删除功能
- `apps/web/components/layout/NavBar.tsx` — 导航栏清理

### 前端删除
- `apps/web/app/(dashboard)/skills/page.tsx` — 废弃页面

### 后端修改
- `apps/api/src/routes/v1/skill-definitions.ts` — 补充 DELETE 路由（如果没有）

## 验收标准

- [ ] `/skill-definitions` 页面可创建技能（含触发词）
- [ ] `/skill-definitions` 页面可删除技能
- [ ] 技能卡片展示触发词
- [ ] 导航栏只有一个技能管理入口
- [ ] `/skills` 页面已删除
- [ ] TypeScript 类型检查通过
