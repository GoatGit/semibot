## Task: Database Seed Data Completion

**ID:** db-seed-data-completion
**Label:** Semibot: 补充数据库种子数据
**Description:** 补充 tools、mcp_servers、usage_records 等缺失表的种子数据，添加边界测试场景
**Type:** Enhancement
**Status:** Completed
**Priority:** Medium
**Created:** 2026-02-06
**Updated:** 2026-02-06
**PRD:** [Link](../PRDS/db-seed-data-completion.md)

---

### Checklist

- [x] 创建 `003_sample_llm_providers.sql` - LLM 提供商和模型数据
- [x] 创建 `004_sample_tools.sql` - 内置工具数据
- [x] 创建 `005_sample_mcp_servers.sql` - MCP 服务器数据
- [x] 创建 `006_sample_usage_and_logs.sql` - 使用量记录和执行日志数据
- [x] 创建 `007_sample_edge_cases.sql` - 边界测试数据
- [x] 添加超长字段测试数据
- [x] 添加特殊字符/Unicode/XSS/SQL 注入测试数据
- [x] 添加异常状态数据（failed、paused、expired、disabled 等）
- [ ] 验证所有种子数据可正确导入 (需在数据库环境执行)
