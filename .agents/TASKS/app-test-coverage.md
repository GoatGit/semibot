## Task: 测试覆盖率提升

**ID:** app-test-coverage
**Label:** Semibot: 提升测试覆盖率至 80%
**Description:** 为 API 和 Web 应用补充单元测试、集成测试和 E2E 测试
**Type:** Enhancement
**Status:** Pending
**Priority:** P0 - Critical
**Created:** 2026-02-06
**Updated:** 2026-02-06
**PRD:** [Link](../PRDS/app-test-coverage.md)

---

### Checklist

#### API 测试 (当前 ~35%)

- [ ] 配置 Vitest coverage thresholds
- [ ] 测试 `agent.service.ts`
- [ ] 测试 `api-keys.service.ts`
- [ ] 测试 `auth.service.ts`
- [ ] 测试 `organization.service.ts`
- [ ] 测试 `session.service.ts`
- [ ] 测试 `tool.service.ts`
- [ ] 测试 `auth.middleware.ts`
- [ ] 测试 `rateLimit.middleware.ts`
- [ ] 测试关键 routes (集成测试)

#### Web 测试 (当前 0%)

- [ ] 配置 Vitest + React Testing Library
- [ ] 创建 `test/setup.ts` 测试配置
- [ ] 添加 `package.json` test 脚本
- [ ] 测试 `Button` 组件
- [ ] 测试 `Input` 组件
- [ ] 测试 `Card` 组件
- [ ] 测试 `sessionStore`
- [ ] 测试 `layoutStore`
- [ ] 测试 `authStore` (新建后)
- [ ] 测试 `Chat` 页面交互
- [ ] 配置 Playwright E2E
- [ ] E2E: 登录流程
- [ ] E2E: 创建会话流程
- [ ] E2E: 发送消息流程

#### CI/CD

- [ ] 创建 `.github/workflows/test.yml`
- [ ] 配置 PR 检查
- [ ] 配置覆盖率报告

### 相关文件

- `apps/api/src/__tests__/*.ts`
- `apps/api/vitest.config.ts`
- `apps/web/src/__tests__/*.tsx` (新建)
- `apps/web/vitest.config.ts` (新建)
- `apps/web/playwright.config.ts` (新建)
