# PRD: 使用量配额限制系统

## 背景

PRODUCT_REQUIREMENTS.md 要求使用量配额管理。当前已实现使用量查询统计（`GET /logs/usage`），但缺少配额定义、配额检查和超限拦截逻辑。用户可以无限制地消耗资源。

## 功能需求

### 1. 配额定义

- 按组织级别定义配额（Free/Pro/Enterprise）
- 配额维度：Token 用量（月）、API 调用次数（月）、并发 Agent 执行数、存储空间
- 支持自定义配额覆盖（针对特定组织）

### 2. 配额检查

- 每次 Chat 请求前检查 Token 配额
- 每次 API 调用前检查调用次数配额
- Agent 执行前检查并发数配额
- 使用 Redis 缓存当前用量，避免每次查库

### 3. 超限处理

- 超限返回 HTTP 429 + 明确的错误信息（哪个配额超限、当前用量、限制值）
- 接近配额（80%）时在响应头中添加警告
- 支持配额告警通知（预留 Webhook 接口）

### 4. 配额查询

- 用户可查看当前配额使用情况
- 显示各维度的已用/总量/剩余

## 技术方案

### 数据模型

```sql
CREATE TABLE quota_plans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(50) NOT NULL UNIQUE,
  limits JSONB NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE org_quotas (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL UNIQUE,
  plan_id UUID NOT NULL,
  custom_limits JSONB,
  period_start TIMESTAMP NOT NULL,
  period_end TIMESTAMP NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```

### API 端点

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | /api/v1/quotas/current | 当前配额使用情况 |
| GET | /api/v1/quotas/plans | 可用配额方案 |

### 配额检查中间件

```typescript
// middleware/quota.ts
export function checkQuota(dimension: 'tokens' | 'api_calls' | 'concurrency') {
  return async (req, res, next) => {
    const usage = await quotaService.getCurrentUsage(req.orgId, dimension);
    const limit = await quotaService.getLimit(req.orgId, dimension);
    if (usage >= limit) {
      throw createError(429, 'QUOTA_EXCEEDED', `${dimension} 配额已用尽`);
    }
    if (usage >= limit * 0.8) {
      res.setHeader('X-Quota-Warning', `${dimension} 使用已达 ${Math.round(usage/limit*100)}%`);
    }
    next();
  };
}
```

### 涉及文件

- 新增 `apps/api/src/middleware/quota.ts`
- 新增 `apps/api/src/services/quota.service.ts`
- 新增 `apps/api/src/repositories/quota.repository.ts`
- 新增 `apps/api/src/routes/v1/quotas.ts`
- 修改 `apps/api/src/routes/v1/chat.ts` — 接入配额检查
- 修改 `apps/api/src/routes/v1/index.ts` — 注册路由
- 新增 `docs/sql/018_quotas.sql`

## 优先级

**P1 — 商业化基础能力，防止资源滥用**

## 验收标准

- [ ] 配额方案可定义和查询
- [ ] Chat 请求前检查 Token 配额
- [ ] 超限返回 429 + 明确错误信息
- [ ] 接近配额时响应头包含警告
- [ ] 当前用量可查询
- [ ] Redis 缓存用量数据
- [ ] 单元测试覆盖
