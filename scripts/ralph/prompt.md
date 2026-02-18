# Ralph Agent Loop Prompt

你是一个自动化开发 agent，负责实现 semibot-x1 项目中的 user stories。

## 工作流程

1. 先读取 `scripts/ralph/log.md` 了解之前的工作进展
2. 读取 `docs/user-stories/` 目录下所有 `.json` 文件
3. 找到 `passes: false` 的 user story（按 batch 顺序优先：batch-1 > batch-2 > batch-3）
4. 每次迭代只处理一个 story，对其中的 acceptance_criteria：
   a. 理解验收标准和影响范围
   b. 阅读相关源码，理解现有实现
   c. 编写代码实现功能（TDD：先写测试，再写实现）
   d. 运行验证：`pnpm --filter @semibot/api test`、`pnpm --filter @semibot/api type-check`、`pnpm lint`
   e. 如果验证通过，将对应 acceptance_criteria 的 `passes` 更新为 `true`
   f. 当所有 AC 通过后，将 story 顶层 `passes` 更新为 `true`
   g. 如果验证失败，记录失败原因并尝试修复
5. 将本次工作记录追加到 `scripts/ralph/log.md`
6. 提交代码（git commit）

## 当前项目信息

- 前端：Next.js (端口 3100)
- 后端 API：Node.js/Express + TypeScript (端口 3101)
- Runtime：Python/FastAPI (端口 8901)
- 包管理���：pnpm (monorepo with turbo)
- 单元测试：Vitest (`pnpm --filter @semibot/api test`)
- E2E 测试：Playwright (`pnpm exec playwright test`)
- 类型检查：`pnpm --filter @semibot/api type-check`
- Lint：`pnpm lint`
- 环境变量：.env.local

## 重构计划参考

详见 `docs/REFACTORING_PLAN.md`，6 项重构按批次执行：

| 批次 | Story | 说明 |
|------|-------|------|
| batch-1 | US-R01 | Repository 泛型基类抽取 |
| batch-1 | US-R05 | 请求追踪中间件（Trace ID） |
| batch-2 | US-R03 | SSE 通信层抽取 |
| batch-2 | US-R04 | 跨层错误协议统一 |
| batch-3 | US-R02 | LLM Provider 去重 |
| batch-3 | US-R06 | 前后端类型自动同步 |

## 编码规范

- 不引入新的 ESLint warning
- 不破坏现有外部接口（纯内部重构）
- 每个 Repository 迁移后单独跑测试验证
- catch 块使用 `error: unknown` + 类型守卫，不用 `any`
- 测试文件可以使用 `any`（ESLint overrides 已配置）

## 验证脚本

运行 `pnpm tsx scripts/ralph/verify.ts` 检查所有 user stories 的状态。
