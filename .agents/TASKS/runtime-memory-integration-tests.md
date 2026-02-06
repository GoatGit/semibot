## Task: Runtime Memory 集成测试补充

**ID:** runtime-memory-integration-tests
**Label:** Semibot: 为 Memory 模块添加 Redis/PostgreSQL 集成测试
**Description:** 使用 testcontainers 创建真实依赖的集成测试，验证 TTL、并发、向量搜索等功能
**Type:** Test
**Status:** Backlog
**Priority:** High
**Created:** 2026-02-06
**Updated:** 2026-02-06
**PRD:** [Link](../PRDS/runtime-memory-integration-tests.md)

---

### Checklist

- [ ] 添加 testcontainers-python 依赖到 requirements-dev.txt
- [ ] 创建 `runtime/tests/memory/conftest.py` 容器 fixture
- [ ] 创建 `runtime/tests/memory/integration/` 目录结构
- [ ] 实现 ShortTermMemory 集成测试
  - [ ] TTL 过期测试
  - [ ] 并发写入测试
  - [ ] 会话条目上限测试
- [ ] 实现 LongTermMemory 集成测试
  - [ ] 向量相似度搜索测试
  - [ ] 多租户隔离测试
  - [ ] importance 更新测试
  - [ ] get_by_agent 测试
- [ ] 配置 pytest markers 支持跳过集成测试
- [ ] 更新 CI 配置支持集成测试
- [ ] 验证所有集成测试通过
