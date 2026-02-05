## Task: MCP 连接测试实现

**ID:** app-mcp-connection-test
**Label:** Semibot: 实现 MCP Server 连接测试
**Description:** 完成 mcp.service.ts 中 testConnection() 的实际实现
**Type:** Feature
**Status:** Pending
**Priority:** P2 - Medium
**Created:** 2026-02-06
**Updated:** 2026-02-06
**PRD:** N/A

---

### Checklist

- [ ] 分析 MCP 协议连接方式 (stdio/sse)
- [ ] 实现 stdio 类型连接测试
- [ ] 实现 sse 类型连接测试
- [ ] 添加连接超时处理
- [ ] 添加错误消息本地化
- [ ] 移除 TODO 注释
- [ ] 编写单元测试

### 相关文件

- `apps/api/src/services/mcp.service.ts` (第 241 行)
- `apps/api/src/__tests__/mcp.service.test.ts`
