## Task: Memory Collection Relation Fix

**ID:** db-memory-collection-relation
**Label:** Semibot: 修复 memories 表缺少 collection_id 关联
**Description:** 为 memories 表添加 collection_id 字段，使记忆可以关联到记忆集合
**Type:** Bug
**Status:** Completed
**Priority:** Medium
**Created:** 2026-02-06
**Updated:** 2026-02-06
**PRD:** [Link](../PRDS/db-memory-collection-relation.md)

---

### Checklist

- [x] 创建迁移脚本 `009_add_memory_collection_relation.sql`
- [x] 添加 collection_id 字段
- [x] 创建索引
- [x] 更新 search_similar_memories 函数支持 collection 过滤
- [ ] 更新 Repository 层代码 (后续任务)
- [ ] 编写测试验证 (后续任务)
