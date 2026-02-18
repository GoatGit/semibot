# PRD: 工程化能力补全（幂等性 + SSE 消息缓冲 + 国际化）

## 背景

设计文档中规划了多项工程化能力，当前仅部分实现或完全缺失：

1. **任务幂等性**：ARCHITECTURE.md 要求 `session_id + step_id` 去重，数据模型有字段但无检查逻辑
2. **SSE 消息缓冲**：断线期间消息丢失，无缓冲队列
3. **国际化**：产品需求要求中英日韩，当前全部硬编码中文

## 功能需求

### 1. 任务幂等性

- Chat 请求携带 `requestId`（客户端生成的 UUID）
- 服务端在执行前检查 `requestId` 是否已处理
- 使用 Redis SET + TTL（5 分钟）存储已处理的 requestId
- 重复请求返回之前的结果而非重新执行

### 2. SSE 消息缓冲

- 服务端为每个 SSE 连接维护一个有界消息队列（最近 100 条）
- 每条消息携带递增的 `eventId`
- 客户端重连时通过 `Last-Event-ID` header 恢复
- 服务端从缓冲队列中重放丢失的消息

### 3. 国际化（i18n）

- 后端错误消息支持多语言（通过 `Accept-Language` header）
- 前端使用 next-intl 或 i18next 管理翻译
- 初期支持 zh-CN 和 en-US
- 翻译文件放在 `apps/web/messages/` 目录

## 技术方案

### 幂等性中间件

```typescript
// middleware/idempotency.ts
export function idempotency() {
  return async (req, res, next) => {
    const requestId = req.headers['x-request-id'];
    if (!requestId) return next();
    const cached = await redis.get(`idempotency:${requestId}`);
    if (cached) return res.json(JSON.parse(cached));
    // 标记处理中
    await redis.set(`idempotency:${requestId}`, 'processing', 'EX', 300);
    // 拦截响应写入缓存
    const originalJson = res.json.bind(res);
    res.json = (data) => {
      redis.set(`idempotency:${requestId}`, JSON.stringify(data), 'EX', 300);
      return originalJson(data);
    };
    next();
  };
}
```

### SSE 消息缓冲

```typescript
// 在 SSEManager 中维护消息缓冲
class SSEMessageBuffer {
  private buffer: Map<string, { eventId: number; data: string }[]> = new Map();
  private maxSize = 100;

  push(connectionId: string, data: string): number {
    // 添加到缓冲，返回 eventId
  }

  replay(connectionId: string, lastEventId: number): { eventId: number; data: string }[] {
    // 返回 lastEventId 之后的所有消息
  }
}
```

### 涉及文件

**幂等性：**
- 新增 `apps/api/src/middleware/idempotency.ts`
- 修改 `apps/api/src/routes/v1/chat.ts` — 接入幂等性中间件

**SSE 缓冲：**
- 修改 `apps/api/src/services/chat.service.ts` — 添加消息缓冲
- 修改 `apps/web/hooks/useSSE.ts` — 重连时发送 Last-Event-ID

**国际化：**
- 新增 `apps/web/messages/zh-CN.json`
- 新增 `apps/web/messages/en-US.json`
- 新增 `apps/web/lib/i18n.ts`
- 修改 `apps/web/app/layout.tsx` — 接入 i18n provider
- 新增 `apps/api/src/lib/i18n.ts` — 后端错误消息国际化

## 优先级

**P2 — 工程化能力，提升系统健壮性和可用性**

## 验收标准

- [ ] 重复 requestId 的请求返回缓存结果
- [ ] SSE 断线重连后丢失的消息被重放
- [ ] 前端支持 zh-CN / en-US 切换
- [ ] 后端错误消息根据 Accept-Language 返回对应语言
- [ ] 单元测试覆盖
