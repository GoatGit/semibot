## Task: Runtime Memory Embedding 缓存实现

**ID:** runtime-memory-embedding-cache
**Label:** Semibot: 实现 EmbeddingService 的 Redis 缓存
**Description:** 创建 RedisEmbeddingCache 类减少重复 embedding API 调用成本
**Type:** Enhancement
**Status:** Backlog
**Priority:** Medium
**Created:** 2026-02-06
**Updated:** 2026-02-06
**PRD:** [Link](../PRDS/runtime-memory-embedding-cache.md)

---

### Checklist

- [ ] 创建 `RedisEmbeddingCache` 类
- [ ] 实现 `get()` 方法（缓存读取）
- [ ] 实现 `set()` 方法（缓存写入）
- [ ] 实现文本哈希键生成
- [ ] 支持配置 TTL
- [ ] 优化 `EmbeddingService.embed_batch()` 支持部分缓存
- [ ] 更新 `__init__.py` 导出 `RedisEmbeddingCache`
- [ ] 添加缓存命中/未命中测试
- [ ] 添加 TTL 过期测试
- [ ] 添加批量部分缓存测试
