## Task: Chat Service 核心功能实现

**ID:** app-chat-service-implementation
**Label:** Semibot: 实现 Chat Service LLM 集成
**Description:** 将 chat.service.ts 从模拟实现改造为真实 LLM 调用
**Type:** Feature
**Status:** Pending
**Priority:** P0 - Critical
**Created:** 2026-02-06
**Updated:** 2026-02-06
**PRD:** [Link](../PRDS/app-chat-service-implementation.md)

---

### Checklist

- [ ] 创建 `llm.service.ts` LLM Provider 抽象层
- [ ] 实现 OpenAI Provider
- [ ] 实现 Anthropic Provider (可选)
- [ ] 实现 DeepSeek Provider (可选)
- [ ] 修改 `chat.service.ts` 移除模拟延迟
- [ ] 集成 LLM Provider 调用
- [ ] 实现 SSE 流式输出
- [ ] 实现 Provider Fallback 机制
- [ ] 添加 Token 使用量记录
- [ ] 添加错误处理和超时控制
- [ ] 编写单元测试 (覆盖率 > 80%)
- [ ] 编写集成测试

### 相关文件

- `apps/api/src/services/chat.service.ts`
- `apps/api/src/services/llm.service.ts` (新建)
- `apps/api/src/services/llm/openai.provider.ts` (新建)
- `apps/api/src/services/llm/anthropic.provider.ts` (新建)
