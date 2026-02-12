# TASK-48: 类型定义统一与去重

## 优先级: P2

## PRD

[shared-types-consolidation.md](../PRDS/shared-types-consolidation.md)

## 描述

三个 skill 相关 repository 各自定义了实体类型（SkillDefinition、SkillPackage、SkillInstallLog），与 `packages/shared-types/src/dto.ts` 中的定义字段不一致，违反"类型单一来源"原则。

## 涉及文件

- `packages/shared-types/src/dto.ts`
- `apps/api/src/repositories/skill-definition.repository.ts`
- `apps/api/src/repositories/skill-package.repository.ts`
- `apps/api/src/repositories/skill-install-log.repository.ts`
- `apps/web/types/index.ts`

## 行动项

1. 对齐 shared-types 与数据库实际 schema
2. Repository 保留 `Row` 类型（内部），实体类型从 shared-types 导入
3. 前端重复类型改为 re-export
4. 验证 TypeScript 编译通过

## 验收标准

- [ ] Repository 不再定义重复实体类型
- [ ] shared-types 类型与数据库 schema 对齐
- [ ] 前端重复类型已清理
- [ ] TypeScript 编译通过

## 状态: 待处理
