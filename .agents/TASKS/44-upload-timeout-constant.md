# TASK-44: upload 超时常量提取

## 优先级: P2

## PRD

[frontend-api-client-hardening.md](../PRDS/frontend-api-client-hardening.md)

## 描述

`apps/web/lib/api.ts:276` 的 `timeout = 120000` 硬编码，应提取为 shared-config 常量。

## 涉及文件

- `apps/web/lib/api.ts` L276
- `packages/shared-config/` — 新增 `UPLOAD_TIMEOUT_MS`

## 修复方式

```typescript
// packages/shared-config
export const UPLOAD_TIMEOUT_MS = 120_000

// apps/web/lib/api.ts
import { UPLOAD_TIMEOUT_MS } from '@semibot/shared-config'
// ...
timeout = UPLOAD_TIMEOUT_MS,
```

## 验收标准

- [ ] 超时常量已提取到 shared-config
- [ ] api.ts 引用常量

## 状态: 待处理
