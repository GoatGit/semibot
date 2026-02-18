# TASK-59: Webhook 事件分发系统

## 优先级: P1 — 设计文档已规划，外部集成基础能力

## PRD

[Webhook 事件分发系统](../PRDS/missing-webhook-system.md)

## 描述

API_DESIGN.md 规划了 CRUD /webhooks 端点，当前完全缺失。需要实现 Webhook 订阅管理、事件异步分发（HMAC 签名 + 重试）、推送日志。

## 涉及文件

- 新增 `apps/api/src/routes/v1/webhooks.ts`
- 新增 `apps/api/src/services/webhook.service.ts`
- 新增 `apps/api/src/repositories/webhook.repository.ts`
- 修改 `apps/api/src/routes/v1/index.ts` — 注册路由
- 修改 `apps/api/src/events/evolution.events.ts` — 行 70，接入 Webhook 分发
- 新增 `docs/sql/016_webhooks.sql`
- 新增 `packages/shared-types/src/webhook.ts`

## 修复方式

1. 创建 `webhooks` 和 `webhook_logs` 数据库表
2. 实现 Webhook CRUD API（POST/GET/PUT/DELETE）
3. 实现事件分发服务：异步推送 + HMAC-SHA256 签名 + 3 次指数退避重试
4. 连续失败 10 次自动禁用
5. 在 evolution.events.ts 中接入 Webhook 分发
6. 实现推送日志查询和测试事件发送

## 验收标准

- [ ] Webhook CRUD API 可用
- [ ] 事件触发后异步推送到订阅 URL
- [ ] HMAC-SHA256 签名验证正确
- [ ] 重试机制工作正常
- [ ] 连续失败自动禁用
- [ ] 推送日志可查询
- [ ] 测试事件可发送
- [ ] 单元测试覆盖

## 状态: 待处理
