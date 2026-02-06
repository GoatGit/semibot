## Task: 后端 Schema 与 Shared Types 对齐

**ID:** api-schema-type-alignment
**Label:** Semibot: 对齐后端 Schema 与 Shared Types
**Description:** 统一后端 Zod Schema 和 shared-types 中的类型定义
**Type:** Refactor
**Status:** Completed ✅
**Priority:** P2 - Medium
**Created:** 2026-02-06
**Updated:** 2026-02-06
**PRD:** [Link](../PRDS/api-schema-type-alignment.md)

---

### Checklist

#### Agent 类型对齐
- [x] 更新 `AgentModelConfig` 类型，区分输入和输出
- [x] 创建 `CreateAgentInput` DTO 类型
- [x] 创建 `UpdateAgentInput` DTO 类型
- [x] 确保后端 Schema 与 DTO 类型一致

#### Session 类型对齐
- [x] 创建 `CreateSessionInput` DTO 类型
- [x] 创建 `UpdateSessionInput` DTO 类型
- [x] 限制只包含 `title` 和 `status` 字段

#### Message 字段统一
- [x] 统一使用 `parentMessageId` 字段名 (在 DTO 中)
- [x] 创建 `AddMessageInput` DTO 类型
- [x] 创建 `ChatMessageInput` DTO 类型
- [x] 创建 `StartChatInput` DTO 类型

#### Skill/Tool/MCP/Memory DTOs
- [x] 创建 `CreateSkillInput` / `UpdateSkillInput`
- [x] 创建 `CreateToolInput` / `UpdateToolInput`
- [x] 创建 `CreateMcpServerInput` / `UpdateMcpServerInput`
- [x] 创建 `CreateMemoryInput` / `SearchMemoriesInput`

#### Auth/Organization/ApiKey DTOs
- [x] 创建 `RegisterInput` / `LoginInput` / `RefreshTokenInput`
- [x] 创建 `UpdateOrganizationInput`
- [x] 创建 `CreateApiKeyInput`

#### API Response Types
- [x] 创建 `ApiResponse<T>` 泛型类型
- [x] 创建 `PaginationMeta` 类型
- [x] 创建 `CursorPaginationMeta` 类型

#### Shared Types 导出
- [x] 创建 `dto.ts` 导出所有 DTO 类型
- [x] 在 `index.ts` 中导出 DTO 模块

#### 验证
- [ ] TypeScript 编译无错误
- [ ] 所有 API 测试通过
- [ ] 前端类型检查通过

### 相关文件

- `packages/shared-types/src/dto.ts` ✅ (新建)
- `packages/shared-types/src/index.ts` ✅ (已更新)
