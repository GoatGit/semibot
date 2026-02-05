# PRD: Chat Service 核心功能实现

## 概述

当前 `chat.service.ts` 仅包含模拟实现，需要完成真实 LLM 调用集成。

## 问题描述

- `chat.service.ts` 第 216-273 行使用硬编码延迟模拟响应
- 无实际 LLM Provider 调用逻辑
- SSE 流式输出框架已就绪，但内容为假数据

## 目标

1. 集成 LLM Provider 调用（OpenAI、Anthropic、DeepSeek 等）
2. 实现真实的流式响应输出
3. 支持多模型切换和 fallback

## 技术方案

### 1. 集成 LLM Provider

```typescript
// services/llm.service.ts
interface LLMProvider {
  chat(messages: Message[], options: ChatOptions): AsyncGenerator<string>
}

class OpenAIProvider implements LLMProvider {
  async *chat(messages, options) {
    const stream = await openai.chat.completions.create({
      model: options.model,
      messages,
      stream: true,
    })
    for await (const chunk of stream) {
      yield chunk.choices[0]?.delta?.content || ''
    }
  }
}
```

### 2. 修改 chat.service.ts

- 移除模拟延迟 `await new Promise(resolve => setTimeout(resolve, ...))`
- 调用实际 LLM Provider
- 处理 token 计数和限流

### 3. 错误处理

- Provider 不可用时的 fallback 机制
- 超时处理
- 速率限制处理

## 验收标准

- [ ] 支持至少 2 个 LLM Provider（OpenAI + 一个国产）
- [ ] SSE 流式输出正常工作
- [ ] 错误时返回友好提示
- [ ] Token 使用量正确记录
- [ ] 单元测试覆盖率 > 80%

## 优先级

**P0 - 阻塞性** - 核心功能不可用

## 相关文件

- `apps/api/src/services/chat.service.ts`
- `apps/api/src/services/llm.service.ts` (新建)
- `database/migrations/006_add_llm_providers.sql`
