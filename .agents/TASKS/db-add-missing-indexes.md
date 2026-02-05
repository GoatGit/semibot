## Task: Database Missing Indexes

**ID:** db-add-missing-indexes
**Label:** Semibot: 添加数据库缺失索引
**Description:** 添加 messages、execution_logs、api_key_logs 等表缺失的复合索引
**Type:** Enhancement
**Status:** Completed
**Priority:** Medium
**Created:** 2026-02-06
**Updated:** 2026-02-06
**PRD:** [Link](../PRDS/db-add-missing-indexes.md)

---

### Checklist

- [x] 创建迁移脚本 `008_add_missing_indexes.sql`
- [x] 添加 messages(session_id, role) 索引
- [x] 添加 execution_logs(org_id, created_at DESC) 索引
- [x] 添加 api_key_logs(api_key_id, created_at DESC) 索引
- [x] 添加 memories(org_id, agent_id, created_at DESC) 索引
- [x] 添加 sessions、agents、skills、usage_records 等额外索引
- [ ] 使用 EXPLAIN ANALYZE 验证索引命中 (需在数据库环境执行)
