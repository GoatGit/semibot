## Task: API 路由输入验证

**ID:** app-input-validation
**Label:** Semibot: 为所有 API 路由添加 Zod 验证
**Description:** 创建 Zod schemas 并应用到所有路由，防止非法输入
**Type:** Security
**Status:** Pending
**Priority:** P0 - Critical
**Created:** 2026-02-06
**Updated:** 2026-02-06
**PRD:** [Link](../PRDS/app-input-validation.md)

---

### Checklist

- [ ] 创建 `schemas/` 目录结构
- [ ] 创建 `schemas/auth.schema.ts` - 认证相关
- [ ] 创建 `schemas/agent.schema.ts` - Agent 相关
- [ ] 创建 `schemas/session.schema.ts` - 会话相关
- [ ] 创建 `schemas/chat.schema.ts` - 聊天相关
- [ ] 创建 `schemas/api-keys.schema.ts` - API Key 相关
- [ ] 创建 `schemas/organization.schema.ts` - 组织相关
- [ ] 创建 `schemas/skill.schema.ts` - 技能相关
- [ ] 创建 `schemas/tool.schema.ts` - 工具相关
- [ ] 创建 `schemas/mcp.schema.ts` - MCP 相关
- [ ] 创建 `schemas/memory.schema.ts` - 记忆相关
- [ ] 创建 `schemas/common.schema.ts` - 公共类型 (UUID, pagination)
- [ ] 应用 validate() 中间件到所有路由
- [ ] 验证错误响应格式统一
- [ ] 安全测试 (SQL 注入、XSS)
- [ ] 编写 schema 单元测试

### 相关文件

- `apps/api/src/schemas/*.ts` (新建目录)
- `apps/api/src/routes/v1/*.ts`
- `apps/api/src/middleware/errorHandler.ts`
