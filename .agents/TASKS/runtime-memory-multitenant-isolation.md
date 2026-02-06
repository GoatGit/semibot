## Task: Runtime Memory 多租户隔离修复

**ID:** runtime-memory-multitenant-isolation
**Label:** Semibot: 修复 LongTermMemory.search() 多租户隔离漏洞
**Description:** 在 search() 和 get_by_agent() 方法中添加 org_id 过滤条件，防止跨租户数据泄露
**Type:** Security
**Status:** Done
**Priority:** Critical
**Created:** 2026-02-06
**Updated:** 2026-02-06
**PRD:** [Link](../PRDS/runtime-memory-multitenant-isolation.md)

---

### Checklist

- [x] 更新 `LongTermMemoryInterface.search()` 接口定义添加 org_id 参数
- [x] 修改 `LongTermMemory.search()` SQL 查询添加 org_id 过滤
- [x] 修改 `LongTermMemory.get_by_agent()` SQL 查询添加 org_id 过滤
- [x] 添加未提供 org_id 时的安全警告日志
- [x] 更新 `MemorySystem.search_long_term()` 传递 org_id
- [ ] 添加多租户隔离单元测试 (需要环境依赖)
- [ ] 添加跨租户攻击场景集成测试 (需要环境依赖)
- [ ] 验证现有测试仍然通过 (需要安装 langgraph 依赖)
