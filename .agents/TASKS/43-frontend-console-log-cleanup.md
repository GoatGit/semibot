# TASK-43: 前端 console 日志替换

## 优先级: P2

## PRD

[frontend-api-client-hardening.md](../PRDS/frontend-api-client-hardening.md)

## 描述

`apps/web/lib/api.ts` 中使用 `console.warn` 和 `console.error` 输出日志，应替换为项目统一 logger 或在生产环境静默。

## 涉及文件

- `apps/web/lib/api.ts` L197, L213, L225

## 修复方式

创建或使用前端 logger 工具，在生产环境控制日志级别。

## 验收标准

- [ ] console.warn/error 替换为项目 logger
- [ ] 生产环境无多余日志输出

## 状态: 待处理
