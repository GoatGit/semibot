## Task: Database Security Function Fix

**ID:** db-security-function-fix
**Label:** Semibot: 修复数据库向量搜索函数多租户隔离漏洞
**Description:** 修复 search_similar_memories 和 search_similar_chunks 函数缺少 org_id 参数导致的跨租户数据泄露风险
**Type:** Bug
**Status:** Completed
**Priority:** Critical
**Created:** 2026-02-06
**Updated:** 2026-02-06
**PRD:** [Link](../PRDS/db-security-function-fix.md)

---

### Checklist

- [x] 创建迁移脚本 `005_fix_security_functions.sql`
- [x] 修复 `search_similar_memories` 函数添加 org_id 参数
- [x] 修复 `search_similar_chunks` 函数添加 org_id 参数
- [x] 更新 `memory.repository.ts` 调用方代码 (已验证：代码已正确实现 orgId 过滤)
- [x] 更新 `memory.service.ts` 传递 org_id (已验证：代码已正确传递 orgId)
- [x] 添加单元测试验证租户隔离 (已验证：测试已覆盖 orgId 参数)
- [ ] 执行迁移脚本验证 (需在数据库环境执行)
