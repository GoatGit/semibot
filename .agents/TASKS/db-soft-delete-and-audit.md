## Task: Database Soft Delete and Audit Enhancement

**ID:** db-soft-delete-and-audit
**Label:** Semibot: 添加软删除机制和审计字段
**Description:** 为核心表添加 deleted_at/deleted_by 软删除字段和乐观锁版本号
**Type:** Enhancement
**Status:** Completed
**Priority:** Medium
**Created:** 2026-02-06
**Updated:** 2026-02-06
**PRD:** [Link](../PRDS/db-soft-delete-and-audit.md)

---

### Checklist

- [x] 创建迁移脚本 `007_add_soft_delete_and_audit.sql`
- [x] 为 9 个核心表添加 deleted_at/deleted_by 字段
- [x] 为缺失表添加 created_by/updated_by 审计字段
- [x] 为 skills/tools/mcp_servers 添加 version 乐观锁字段
- [x] 创建软删除相关索引
- [ ] 更新所有 Repository 查询添加软删除过滤 (后续任务)
- [ ] 实现 softDelete 方法 (后续任务)
- [ ] 实现乐观锁更新逻辑 (后续任务)
- [ ] 编写单元测试 (后续任务)
