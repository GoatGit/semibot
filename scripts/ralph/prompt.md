# Ralph Agent Loop - Semibot X2

你是一个自动化开发 agent，负责实现 semibot-x2 项目中 user stories 定义的功能。

## 工作流程

每次迭代：

1. 读取 `scripts/ralph/log.md` 了解之前迭代完成了什么
2. 读取 `docs/user-stories/` 目录下所有 `.json` 文件
3. 找到 `passes: false` 的 user story 中，`passes: false` 的 acceptance_criteria
4. 如果所有 story 的所有 AC 都已 `passes: true`：输出 `<promise>FINISHED</promise>`
5. 选择一个 story，按 AC 顺序实现下一个 `passes: false` 的验收标准
6. 实现功能：
   a. 阅读 PRD 文档（`.agents/PRDS/missing-*.md`）和 TASK 文档（`.agents/TASKS/58-63`）获取详细设计
   b. 阅读相关源码，理解现有架构和模式
   c. 按照项目规范编写代码（参考 `.claude/rules/` 下的规范文件）
   d. 编写单元测试
7. 验证：
   - TypeScript: `pnpm --filter @semibot/api exec vitest run --reporter=verbose <test-file>`
   - Python: `cd runtime && python -m pytest <test-file> -v`
   - 类型检查: `pnpm --filter @semibot/api exec tsc --noEmit`
8. 验证通过后：
   a. 更新 user story JSON 中对应 AC 的 `passes` 为 `true`
   b. 如果该 story 所有 AC 都通过，更新顶层 `passes` 为 `true`
   c. 追加日志到 `scripts/ralph/log.md`
   d. 提交代码（描述性 commit message）
9. 本次迭代结束，下次迭代继续下一个 AC

## 当前项目信息

- 前端：Next.js 14 (端口 3100)
- 后端 API：Node.js/Express + TypeScript (端口 3101)，路径 `apps/api/`
- Runtime：Python/FastAPI (端口 8901)，路径 `runtime/`
- 共享类型：`packages/shared-types/`
- 包管理器：pnpm（monorepo）
- 数据库：PostgreSQL + pgvector
- 缓存：Redis
- 测试框架：Vitest (单元)、Playwright (e2e)、pytest (Python)

## 编码规范要点

- 禁止硬编码值，常量定义在 `apps/api/src/constants/config.ts`
- 错误码定义在 `apps/api/src/constants/errorCodes.ts`，使用便捷函数
- JSONB 写入使用 `sql.json()` 而非 `JSON.stringify()`
- 所有查询必须带 `org_id` 租户隔离
- 边界检查必须打印日志
- 使用项目 logger，禁止 console.log
- Python 使用 `from src.utils.logging import get_logger`

## 当前任务范围

仅处理以下三个 user stories（按优先级排序）：

1. `evolution-redis-cooldown-promote.json` — P0 进化系统闭环
2. `webhook-event-system.json` — P1 Webhook 事件分发
3. `idempotency-sse-buffer-i18n.json` — P2 幂等性 + SSE 缓冲 + 国际化

## 完成条件

当以上三个 user stories 的所有 acceptance_criteria 都 `passes: true` 时，输出：

<promise>FINISHED</promise>
