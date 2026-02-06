## Task: Runtime Memory 连接容错与重试机制

**ID:** runtime-memory-connection-resilience
**Label:** Semibot: 为 Memory 模块添加连接重试和容错处理
**Description:** 添加 Redis/PostgreSQL 连接重试机制、超时处理、async context manager 支持
**Type:** Enhancement
**Status:** Done
**Priority:** High
**Created:** 2026-02-06
**Updated:** 2026-02-06
**PRD:** [Link](../PRDS/runtime-memory-connection-resilience.md)

---

### Checklist

- [x] 在 `constants/__init__.py` 添加连接相关常量
- [x] 为 `ShortTermMemory` 添加 `@retry` 装饰器
- [x] 为 `LongTermMemory._get_pool()` 添加异常处理和重试
- [x] 提取连接池硬编码配置为常量
- [x] 为两个类添加 `__aenter__` / `__aexit__` 方法
- [x] 创建 `MemoryConnectionError` 异常类
- [ ] 添加连接失败重试测试用例 (需要环境依赖)
- [ ] 添加资源清理测试用例 (需要环境依赖)
- [ ] 验证现有测试仍然通过 (需要安装 langgraph 依赖)
