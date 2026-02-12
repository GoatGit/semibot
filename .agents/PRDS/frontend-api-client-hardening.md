# PRD: 前端 API 客户端加固

## 背景

2026-02 全面审查发现前端 API 客户端存在硬编码 URL、console 日志残留、权限语义不���等问题。

## 问题清单

### 1. 硬编码 fallback URL (P1)

`apps/web/lib/api.ts:51`：
```typescript
return `http://localhost:3001${API_BASE_PATH}`
```

`apps/web/lib/api.ts:283`：
```typescript
const directBase = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001/api/v1'
```

生产环境如果 `NEXT_PUBLIC_API_URL` 未设置会回退到 localhost，应在生产环境抛出错误。

### 2. console.warn/error 残留 (P2)

`api.ts:197, 213, 225` 使用 `console.warn` 和 `console.error`，应使用项目统一 logger 或至少在生产环境静默。

### 3. upload 超时硬编码 (P2)

`api.ts:276` 的 `timeout = 120000` 应提取为 shared-config 常量。

## 修复方案

1. fallback URL 加环境检测：
```typescript
if (typeof window === 'undefined') {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('NEXT_PUBLIC_API_URL must be set in production')
  }
  return `http://localhost:3001${API_BASE_PATH}`
}
```

2. console 替换为条件日志或项目 logger

3. 超时常量提取到 shared-config

## 影响范围

- `apps/web/lib/api.ts`
- `packages/shared-config/` — 新增 UPLOAD_TIMEOUT_MS 常量

## 优先级

P1 (硬编码 URL) / P2 (console、超时)

## 验收标准

- [ ] 生产环境无 localhost fallback
- [ ] console 日志替换为项目 logger
- [ ] 超时常量已提取
