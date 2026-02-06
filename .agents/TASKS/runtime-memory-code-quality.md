## Task: Runtime Memory 代码质量修复

**ID:** runtime-memory-code-quality
**Label:** Semibot: 修复 Memory 模块代码质量问题
**Description:** 修复废弃 API、重复常量定义、硬编码值、日志级别不一致等问题
**Type:** Refactor
**Status:** Backlog
**Priority:** Medium
**Created:** 2026-02-06
**Updated:** 2026-02-06
**PRD:** [Link](../PRDS/runtime-memory-code-quality.md)

---

### Checklist

- [ ] 替换 `datetime.utcnow()` 为 `datetime.now(timezone.utc)`
- [ ] 将 `EMBEDDING_DIMENSION` 移到 `constants/config.py`
- [ ] 删除 `embedding.py` 和 `long_term.py` 中的重复定义
- [ ] 提取连接池配置到 `constants/config.py`
- [ ] 提取 embedding 相关常量到 `constants/config.py`
- [ ] 统一日志级别
  - [ ] 操作成功使用 INFO
  - [ ] 查询结果使用 DEBUG
  - [ ] 边界触发使用 WARN
  - [ ] 错误使用 ERROR
- [ ] 运行 linter 检查
- [ ] 验证所有单元测试通过
