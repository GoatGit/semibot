# PRD: Skills 管理与使用规范（管理员统一管理，全租户可用）

## 概述

| 字段 | 值 |
|------|-----|
| **功能名称** | Skills 管理与使用规范 |
| **版本** | 1.0 |
| **优先级** | P0 |
| **关联任务** | [TASK](../TASKS/skills-management-and-usage-spec.md) |
| **创建时间** | 2026-02-08 |

## 背景

当前 Skills 的“创建/安装/使用”能力存在协议语义和工程语义偏差：
- 手动创建仅保存元数据，不是目录型技能安装；
- Anthropic 安装目前主要是元数据透传，不是完整包安装；
- 管理侧与执行侧职责边界不清晰，导致“可管理但不可稳定执行”。

平台目标已经明确为：
- Skills 仅由管理员统一 CRUD；
- 全租户共享可见；
- 仍需保留执行上下文隔离（org/session/user）与审计。

## 目标

1. 定义平台级 Skills 对象模型（Registry Entry）与目录包模型（Package）；
2. 定义统一安装流程（Catalog 发现、Manifest 解析、Package 落盘、版本管理）；
3. 定义统一使用流程（Agent 绑定、Chat 执行、审计与观测）；
4. 与 Anthropic/Codex 的目录型技能理念对齐。

## 非目标

- 本 PRD 不要求实现 marketplace 商业能力（计费、评分、推荐）；
- 本 PRD 不要求实现跨地域多活同步；
- 本 PRD 不改动最终 UI 视觉规范，仅定义功能行为。

## 关键需求

### 1. 管理模型规范

- 引入两层实体：
  - `SkillDefinition`（平台逻辑定义，管理员管理）；
  - `SkillPackage`（可执行目录包，按版本存储）。
- `SkillDefinition` 对所有租户可见，不按租户隔离权限。
- `SkillPackage` 必须可追溯来源（git/url/registry/local）、版本、校验值（sha256）。

### 2. 安装规范

- 支持三种安装入口：
  1) 手动输入 `skill_id`；
  2) 通过 `manifest_url`；
  3) 通过 `catalog` 发现项安装。
- 安装步骤必须原子化：
  1) 拉取 manifest；
  2) 校验字段（skill_id、name、version）；
  3) 下载/展开 package 目录；
  4) 校验目录结构（`SKILL.md` 至少存在）；
  5) 记录到数据库并标记可用。

### 3. 使用规范

- Agent 绑定 Skill 时绑定的是 `SkillDefinition` + 可解析到可执行版本。
- Runtime 执行前必须解析到确定包版本（默认 latest，可锁版本）。
- Chat 执行需输出技能调用审计：skill_id、version、tool_name、status、latency、error_code。

### 4. 安全与隔离规范

- 即使全租户可用，也必须保留执行上下文隔离：
  - 传递 `org_id/session_id/user_id`；
  - 缓存键和临时文件按 org 命名空间隔离；
  - 审计日志按 org 聚合查询。
- 禁止 skill 目录直接读写宿主敏感路径，必须经过 sandbox/policy。

### 5. 协议对齐

- Anthropic 方向：支持 `container.skills` 透传，但不以此替代本地包安装。
- Codex 方向：支持 `SKILL.md + scripts/ + references/` 目录语义。
- 平台内部定义统一最小兼容字段：
  - `skill_id`、`name`、`description`、`version`、`entry`、`tools`。

## API 需求（增量）

- `GET /skills/catalog/anthropic`：可安装目录发现；
- `POST /skills/install/anthropic`：通过 skill_id 安装；
- `POST /skills/install/anthropic/manifest`：通过 manifest 安装；
- `POST /skills/:id/publish`：发布新版本；
- `GET /skills/:id/versions`：查询可用版本；
- `POST /skills/:id/rollback`：回滚版本（管理员）。

## 数据模型变更建议

- 新表 `skill_definitions`（平台级定义）；
- 新表 `skill_packages`（版本包、来源、校验、路径、状态）；
- 新表 `skill_install_logs`（安装日志）；
- `agents.skills` 建议改为结构化绑定（含可选版本锁定）。

## 验收标准

- 管理端可完成目录型 skill 的安装/发布/回滚；
- 任一 skill 可追溯来源、版本、校验值；
- Agent 绑定后可在运行时稳定解析到可执行包；
- 全租户共享前提下，执行日志与状态仍可按 org 追踪；
- 协议对齐清单（Anthropic/Codex）有自动化校验。

## 风险与缓解

- 风险：仅做元数据安装导致“可见不可用”。
  - 缓解：安装流程强制目录与入口校验。
- 风险：全租户共享导致跨组织数据串扰。
  - 缓解：执行上下文命名空间隔离 + 审计。
- 风险：第三方包供应链风险。
  - 缓解：hash 校验、来源白名单、签名校验预留。
