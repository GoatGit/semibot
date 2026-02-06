## Task: 前端 API Hooks 补充

**ID:** web-frontend-api-hooks
**Label:** Semibot: 补充前端 API Hooks
**Description:** 为后端所有 REST API 模块创建对应的前端 React Hooks
**Type:** Feature
**Status:** Completed ✅
**Priority:** P1 - High
**Created:** 2026-02-06
**Updated:** 2026-02-06
**PRD:** [Link](../PRDS/web-frontend-api-hooks.md)

---

### Checklist

#### Agent 模块
- [x] 创建 `useAgent.ts` Hook
- [x] 实现 `loadAgents` - 列表查询
- [x] 实现 `createAgent` - 创建
- [x] 实现 `updateAgent` - 更新
- [x] 实现 `deleteAgent` - 删除
- [x] 实现 `selectAgent` - 选择详情

#### Skill 模块
- [x] 创建 `useSkill.ts` Hook
- [x] 实现 CRUD 操作
- [x] 支持 `includeBuiltin` 过滤

#### Tool 模块
- [x] 创建 `useTool.ts` Hook
- [x] 实现 CRUD 操作
- [x] 支持 `type` 和 `includeBuiltin` 过滤

#### MCP 模块
- [x] 创建 `useMcp.ts` Hook
- [x] 实现 CRUD 操作
- [x] 实现 `testConnection` - 测试连接
- [x] 实现 `syncToolsAndResources` - 同步工具

#### Memory 模块
- [x] 创建 `useMemory.ts` Hook
- [x] 实现 CRUD 操作
- [x] 实现 `searchSimilar` - 向量搜索
- [x] 实现 `cleanup` - 清理过期记忆

#### Logs 模块
- [x] 创建 `useLogs.ts` Hook
- [x] 实现 `loadExecutionLogs` - 执行日志
- [x] 实现 `loadUsageRecords` - 使用量记录
- [x] 实现 `getUsageSummary` - 使用量汇总

#### Organization 模块
- [x] 创建 `useOrganization.ts` Hook
- [x] 实现 `getCurrentOrganization` - 获取当前组织
- [x] 实现 `updateOrganization` - 更新组织
- [x] 实现 `getMembers` - 获取成员列表

#### API Keys 模块
- [x] 创建 `useApiKeys.ts` Hook
- [x] 实现 `createApiKey` - 创建密钥
- [x] 实现 `listApiKeys` - 列表密钥
- [x] 实现 `deleteApiKey` - 删除密钥

#### 测试
- [ ] 为每个 Hook 编写单元测试
- [ ] 测试覆盖率 > 80%

### 相关文件

- `apps/web/hooks/useAgent.ts` ✅ (新建)
- `apps/web/hooks/useSkill.ts` ✅ (新建)
- `apps/web/hooks/useTool.ts` ✅ (新建)
- `apps/web/hooks/useMcp.ts` ✅ (新建)
- `apps/web/hooks/useMemory.ts` ✅ (新建)
- `apps/web/hooks/useLogs.ts` ✅ (新建)
- `apps/web/hooks/useOrganization.ts` ✅ (新建)
- `apps/web/hooks/useApiKeys.ts` ✅ (新建)
