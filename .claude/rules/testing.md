# 测试规范

## 覆盖率目标

- 核心模块（Repository、Service、Middleware）：80%+
- 前端组件：70%+

---

## 优先级

优先测试高风险模块：Sandbox、Auth、多租户隔离、Repository 层。

---

## 测试隔离

- 外部依赖用 mock（fakeredis、mock HTTP、mock LLM provider）
- 测试必须可独立运行，不依赖外部环境
- 每个测试自行清理数据，用 Factory 模式生成测试数据

---

## 安全测试

显式验证危险操作被阻断：`os.system`、`eval`、`exec`、`socket`、文件写入。

---

## 并发安全测试

用 `asyncio.gather()` 测试 `close_all()` 等资源清理无竞态。
