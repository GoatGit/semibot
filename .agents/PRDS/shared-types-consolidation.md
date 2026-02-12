# PRD: 类型定义统一与去重

## 背景

2026-02 全面审查发现 skill 相关 repository 各自定义了实体类型，与 `packages/shared-types/src/dto.ts` 中的定义字段不一致，违反"类型单一来源"原则。

## 问题详情

### 类型重复对照

| 实体 | shared-types 定义 | Repository 定义 | 差异 |
|------|------------------|----------------|------|
| SkillDefinition | dto.ts — 含 protocol, sourceType, sourceUrl, status 等 | skill-definition.repository.ts — 仅基础字段 | Repository 缺少多个字段 |
| SkillPackage | dto.ts — 含 manifestUrl, sourceRef, deprecatedAt 等 | skill-package.repository.ts — 缺少这些字段 | Repository 缺少扩展字段 |
| SkillInstallLog | dto.ts — 含 step, progress, errorCode, durationMs 等 | skill-install-log.repository.ts — 仅基础字段 | Repository 缺少进度追踪字段 |

### 前端类型额外定义

`apps/web/types/index.ts` 定义了 `User`、`Organization`、`AgentConfig` 等类型，部分与 shared-types 重复。

## 修复方案

1. Repository 内部保留 `Row` 类型（数据库行映射，snake_case）
2. Repository 的输入类型（`CreateXxxData`、`UpdateXxxData`）和输出实体类型统一从 `shared-types` 导入
3. `rowToEntity` 转换函数负责 Row → shared-types Entity 的映射
4. 前端 `types/index.ts` 中与 shared-types 重复的类型改为 re-export

## 影响范围

- `packages/shared-types/src/dto.ts` — 可能需要调整字段使其与数据库实际 schema 对齐
- `apps/api/src/repositories/skill-*.repository.ts` — 移除重复类型定义
- `apps/web/types/index.ts` — 清理重复类型

## 优先级

P2

## 验收标准

- [ ] Repository 不再定义与 shared-types 重复的实体类型
- [ ] shared-types 中的类型与数据库 schema 对齐
- [ ] 前端重复类型已清理
- [ ] TypeScript 编译通过
