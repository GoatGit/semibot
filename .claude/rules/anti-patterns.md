# 常见反模式（禁止）

| 反模式 | 正确做法 |
|--------|----------|
| 循环内逐条 `await` | 用 `asyncio.gather()` / `Promise.all()` 并行 |
| 类型重复定义 | 统一在 `packages/shared-types/` |
| 硬编码超时/限制 | 提取到 `constants/config.ts` |
| 缺少 `org_id` 过滤 | 所有查询必须带租户隔离 |
| 占位符代码上线（`// TODO: implement`） | 要么实现要么显式报错 |
| 不完整的资源清理 | 按初始化逆序关闭所有组件 |
| 静默吞异常 | catch 后必须打日志并抛出或处理 |
| Mock 数据残留生产 | 及时替换为真实 API 调用 |
| `JSON.stringify()` 写 JSONB 列 | 使用 `sql.json()` |
