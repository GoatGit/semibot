# PRD: 测试覆盖率提升

## 概述

当前测试覆盖率严重不足：API 约 30-40%，Web 为 0%，违反项目要求的 80% 最低标准。

## 问题描述

### API (`apps/api`)

**有测试的模块：**
- chat.service.test.ts
- config.test.ts
- logs.service.test.ts
- mcp.service.test.ts
- memory.service.test.ts
- skill.service.test.ts

**缺失测试的模块：**
- agent.service.ts
- api-keys.service.ts
- auth.service.ts
- organization.service.ts
- queue.service.ts
- session.service.ts
- tool.service.ts
- 所有 middleware
- 所有 routes
- 所有 repositories

### Web (`apps/web`)

- 无任何测试文件
- 无测试配置
- 无 package.json 测试脚本

## 目标

1. API 测试覆盖率达到 80%+
2. Web 测试覆盖率达到 80%+
3. 建立 CI 测试流水线

## 技术方案

### 1. 测试框架配置

**API (已有 Vitest):**
```typescript
// vitest.config.ts
export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: ['node_modules', 'dist', '**/*.d.ts'],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 80,
        statements: 80,
      },
    },
  },
})
```

**Web (新建):**
```typescript
// vitest.config.ts
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    coverage: {
      thresholds: { lines: 80, functions: 80, branches: 80 },
    },
  },
})
```

### 2. 测试优先级

#### P0 - 核心功能
| 模块 | 测试类型 |
|------|----------|
| auth.service | 单元 + 集成 |
| agent.service | 单元 |
| session.service | 单元 |
| auth middleware | 单元 + 集成 |
| Button, Input 组件 | 单元 |
| authStore | 单元 |

#### P1 - 重要功能
| 模块 | 测试类型 |
|------|----------|
| api-keys.service | 单元 |
| organization.service | 单元 |
| tool.service | 单元 |
| rateLimit middleware | 单元 |
| SessionStore | 单元 |
| Chat 页面 | 集成 |

#### P2 - 辅助功能
| 模块 | 测试类型 |
|------|----------|
| repositories | 单元 |
| 其他组件 | 单元 |
| E2E 测试 | Playwright |

### 3. 测试示例

```typescript
// api/__tests__/auth.service.test.ts
describe('AuthService', () => {
  describe('register', () => {
    it('should create user with hashed password', async () => {
      const result = await authService.register({
        email: 'test@example.com',
        password: 'Password123!',
        name: 'Test User',
      })
      expect(result.user.email).toBe('test@example.com')
      expect(result.user.password).toBeUndefined()
    })

    it('should reject duplicate email', async () => {
      await expect(authService.register({
        email: 'existing@example.com',
        password: 'Password123!',
      })).rejects.toThrow('EMAIL_EXISTS')
    })
  })
})

// web/__tests__/Button.test.tsx
describe('Button', () => {
  it('renders with correct variant', () => {
    render(<Button variant="primary">Click</Button>)
    expect(screen.getByRole('button')).toHaveClass('bg-primary-500')
  })

  it('shows loading spinner when loading', () => {
    render(<Button loading>Submit</Button>)
    expect(screen.getByRole('button')).toBeDisabled()
    expect(screen.getByTestId('loading-spinner')).toBeInTheDocument()
  })
})
```

## 验收标准

- [ ] API 测试覆盖率 >= 80%
- [ ] Web 测试覆盖率 >= 80%
- [ ] CI 流水线自动运行测试
- [ ] 测试失败阻止合并
- [ ] 覆盖率报告可视化

## 优先级

**P0 - 阻塞性** - 违反项目规范

## 相关文件

- `apps/api/src/__tests__/*.ts`
- `apps/api/vitest.config.ts`
- `apps/web/src/__tests__/*.tsx` (新建)
- `apps/web/vitest.config.ts` (新建)
- `.github/workflows/test.yml`
