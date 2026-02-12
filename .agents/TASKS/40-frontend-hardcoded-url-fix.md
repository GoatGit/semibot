# TASK-40: 前端硬编码 fallback URL 修复

## 优先级: P1

## PRD

[frontend-api-client-hardening.md](../PRDS/frontend-api-client-hardening.md)

## 描述

`apps/web/lib/api.ts` 中有两处硬编码 `http://localhost:3001` 作为 fallback URL，生产环境如果 `NEXT_PUBLIC_API_URL` 未设置会回退到 localhost。

## 涉及文件

- `apps/web/lib/api.ts` L51, L283

## 修复方式

```typescript
// L51 — getApiBaseUrl()
if (typeof window === 'undefined') {
  if (process.env.NODE_ENV === 'production' && !process.env.NEXT_PUBLIC_API_URL) {
    throw new Error('[API] 生产环境必须设置 NEXT_PUBLIC_API_URL')
  }
  return `http://localhost:3001${API_BASE_PATH}`
}

// L283 — upload()
const directBase = process.env.NEXT_PUBLIC_API_URL
if (!directBase && process.env.NODE_ENV === 'production') {
  throw new Error('[API] 生产环境必须设置 NEXT_PUBLIC_API_URL')
}
const url = `${directBase || 'http://localhost:3001/api/v1'}${path}`
```

## 验收标准

- [ ] 生产环境缺少 NEXT_PUBLIC_API_URL 时抛出明确错误
- [ ] 开发环境仍可正常 fallback 到 localhost
- [ ] upload 方法同样处理

## 状态: 待处理
