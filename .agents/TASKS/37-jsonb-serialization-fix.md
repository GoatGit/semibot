# TASK-37: JSONB 双重序列化修复

## 优先级: P0 — 立即修复

## PRD

[skill-repo-data-integrity.md](../PRDS/skill-repo-data-integrity.md)

## 描述

`skill-install-log.repository.ts:88` 使用 `JSON.stringify()` 写入 JSONB 列，违反项目规范，存在双重序列化风险。

## 涉及文件

- `apps/api/src/repositories/skill-install-log.repository.ts` L88

## 修复方式

```typescript
// ❌ 当前
const metadata = JSON.stringify({ version: data.version })

// ✅ 修复
const metadata = sql.json({ version: data.version } as Parameters<typeof sql.json>[0])
```

同时检查 `update()` 方法是否有类似问题。

## 验收标准

- [ ] `JSON.stringify` 替换为 `sql.json()`
- [ ] 写入后读取验证数据为对象而非字符串
- [ ] TypeScript 编译通过

## 状态: 待处理
