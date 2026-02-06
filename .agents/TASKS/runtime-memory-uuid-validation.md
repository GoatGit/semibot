## Task: Runtime Memory UUID 验证与输入校验

**ID:** runtime-memory-uuid-validation
**Label:** Semibot: 修复 Memory 模块 UUID 验证和输入校验缺失
**Description:** 添加 UUID 格式验证和内容非空校验，防止无效输入导致运行时异常
**Type:** Bug
**Status:** Done
**Priority:** Critical
**Created:** 2026-02-06
**Updated:** 2026-02-06
**PRD:** [Link](../PRDS/runtime-memory-uuid-validation.md)

---

### Checklist

- [x] 创建 `runtime/src/utils/validation.py` 验证工具模块
- [x] 实现 `validate_uuid()` 函数
- [x] 实现 `validate_content()` 函数
- [x] 修改 `long_term.py` 的 `save()` 方法添加验证
- [x] 修改 `long_term.py` 的 `search()` 方法添加验证
- [x] 修改 `long_term.py` 的 `delete()` 和 `get()` 方法添加验证
- [x] 修改 `short_term.py` 的 `save()` 方法添加验证
- [x] 添加验证函数单元测试 (34 tests passed)
- [x] 添加无效输入场景测试用例
- [ ] 验证现有测试仍然通过 (需要安装 langgraph 依赖)
