# TASK-63: 工程化能力补全 — 幂等性 + SSE 消息缓冲 + 国际化

## 优先级: P2 — 工程化能力，提升系统健壮性

## PRD

[工程化能力补全](../PRDS/missing-idempotency-sse-i18n.md)

## 描述

三项工程化能力缺失：(1) 任务幂等性 — 数据模型有字段但无检查逻辑；(2) SSE 消息缓冲 — 断线期间消息丢失；(3) 国际化 — 全部硬编码中文。

## 涉及文件

**幂等性：**
- 新增 `apps/api/src/middleware/idempotency.ts`
- 修改 `apps/api/src/routes/v1/chat.ts` — 接入幂等性中间件

**SSE 缓冲：**
- 修改 `apps/api/src/services/chat.service.ts` — 添加消息缓冲队列
- 修改 `apps/web/hooks/useSSE.ts` — 重连时发送 Last-Event-ID

**国际化：**
- 新增 `apps/web/messages/zh-CN.json`
- 新增 `apps/web/messages/en-US.json`
- 新增 `apps/web/lib/i18n.ts`
- 修改 `apps/web/app/layout.tsx` — 接入 i18n provider
- 新增 `apps/api/src/lib/i18n.ts` — 后端错误消息国际化

## 修复方式

### 幂等性
- 请求携带 `X-Request-ID` header
- Redis SET + 5 分钟 TTL 存储已处理的 requestId
- 重复请求返回缓存结果

### SSE 缓冲
- 服务端维护有界消息队列（最近 100 条），每条消息携带递增 eventId
- 客户端重连时通过 Last-Event-ID 恢复

### 国际化
- 前端使用 next-intl，初期支持 zh-CN / en-US
- 后端错误消息根据 Accept-Language 返回对应语言

## 验收标准

- [ ] 重复 requestId 的请求返回缓存结果
- [ ] SSE 断线重连后丢失的消息被重放
- [ ] 前端支持 zh-CN / en-US 切换
- [ ] 后端错误消息支持多语言
- [ ] 单元测试覆盖

## 状态: 待处理
