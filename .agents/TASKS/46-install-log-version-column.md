# TASK-46: skill-install-log version 独立列

## 优先级: P2

## PRD

[skill-repo-data-integrity.md](../PRDS/skill-repo-data-integrity.md)

## 描述

`skill_install_logs` 表的 `version` 字段存储在 `metadata` JSONB 内，读取时从 `metadata.version` 提取。如果 version 是高频查询/过滤字段，应提升为独立列以支持索引和直接查询。

## 涉及文件

- `apps/api/src/repositories/skill-install-log.repository.ts` L70, L88
- `database/migrations/` — 需要新增迁移脚本

## 行动项

1. 评估 version 是否需要作为查询条件
2. 如需要，新增迁移脚本添加 `version` 列
3. 数据迁移：从 metadata->>'version' 填充新列
4. 更新 repository 代码

## 验收标准

- [ ] version 可直接查询（如需要）
- [ ] 历史数据已迁移
- [ ] 迁移脚本幂等

## 状态: 待处理
