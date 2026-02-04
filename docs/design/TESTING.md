# 测试框架设计

## 1. 概述

Semibot 采用分层测试策略，确保系统各层级的质量和稳定性。测试覆盖率目标：**核心模块 80%+**。

## 2. 测试金字塔

```text
                    ┌─────────────┐
                    │   E2E Tests │  ← 端到端测试（关键流程）
                    │   (5-10%)   │
                    ├─────────────┤
                    │ Integration │  ← 集成测试（API、数据库）
                    │   (20-30%)  │
                    ├─────────────┤
                    │ Unit Tests  │  ← 单元测试（核心逻辑）
                    │   (60-70%)  │
                    └─────────────┘
```

## 3. 测试分类

### 3.1 单元测试

**目标**：测试单个函数、类或模块的隔离行为。

**技术栈**：
- **Node.js (API 层)**: Vitest / Jest
- **Python (Runtime)**: pytest

**覆盖范围**：
- 工具函数和辅助方法
- 数据验证逻辑
- 业务规则计算
- 状态转换逻辑

**示例 - Node.js**：

```typescript
// tests/unit/utils/validation.test.ts
import { describe, it, expect } from 'vitest'
import { validateAgentConfig } from '@/utils/validation'

describe('validateAgentConfig', () => {
  it('should pass for valid config', () => {
    const config = {
      name: 'Test Agent',
      model: 'gpt-4o',
      temperature: 0.7
    }
    expect(() => validateAgentConfig(config)).not.toThrow()
  })

  it('should reject temperature > 2', () => {
    const config = { temperature: 2.5 }
    expect(() => validateAgentConfig(config)).toThrow('temperature must be <= 2')
  })
})
```

**示例 - Python**：

```python
# tests/unit/test_state_machine.py
import pytest
from runtime.orchestrator import AgentState, route_after_plan

class TestRouteAfterPlan:
    def test_simple_question_goes_to_respond(self):
        state = AgentState(
            messages=[{"role": "user", "content": "What is 2+2?"}],
            plan={"requires_tools": False}
        )
        assert route_after_plan(state) == "respond"

    def test_tool_required_goes_to_act(self):
        state = AgentState(
            messages=[{"role": "user", "content": "Search for AI news"}],
            plan={"requires_tools": True, "steps": [{"tool": "web_search"}]}
        )
        assert route_after_plan(state) == "act"
```

### 3.2 集成测试

**目标**：测试模块间交互、API 端点、数据库操作。

**技术栈**：
- **API 测试**: Supertest + Vitest
- **数据库测试**: Testcontainers / 内存 SQLite
- **Redis 测试**: ioredis-mock

**覆盖范围**：
- API 端点请求/响应
- 数据库 CRUD 操作
- Redis 缓存/队列操作
- 认证授权流程

**示例 - API 集成测试**：

```typescript
// tests/integration/api/agents.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import { app } from '@/app'
import { setupTestDB, cleanupTestDB, createTestUser } from '../helpers'

describe('Agents API', () => {
  let authToken: string

  beforeAll(async () => {
    await setupTestDB()
    const user = await createTestUser()
    authToken = user.token
  })

  afterAll(async () => {
    await cleanupTestDB()
  })

  describe('POST /v1/agents', () => {
    it('should create a new agent', async () => {
      const response = await request(app)
        .post('/v1/agents')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          name: 'Test Agent',
          system_prompt: 'You are a helpful assistant',
          config: { model: 'gpt-4o' }
        })

      expect(response.status).toBe(201)
      expect(response.body.success).toBe(true)
      expect(response.body.data.name).toBe('Test Agent')
    })

    it('should reject without auth', async () => {
      const response = await request(app)
        .post('/v1/agents')
        .send({ name: 'Test' })

      expect(response.status).toBe(401)
      expect(response.body.error.code).toBe('AUTH_MISSING_TOKEN')
    })
  })
})
```

**示例 - 数据库集成测试**：

```typescript
// tests/integration/db/agents.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { AgentRepository } from '@/repositories/agent'
import { testDb } from '../helpers/db'

describe('AgentRepository', () => {
  let repo: AgentRepository

  beforeEach(async () => {
    await testDb.reset()
    repo = new AgentRepository(testDb)
  })

  it('should create and retrieve agent', async () => {
    const created = await repo.create({
      org_id: 'org_123',
      name: 'Test Agent',
      system_prompt: 'Hello'
    })

    const found = await repo.findById(created.id)
    expect(found?.name).toBe('Test Agent')
  })
})
```

### 3.3 端到端测试 (E2E)

**目标**：验证关键用户流程的完整性。

**技术栈**：
- **Web UI**: Playwright
- **API E2E**: 自定义测试框架

**覆盖范围**：
- 用户注册/登录流程
- Agent 创建和配置流程
- 对话交互完整流程
- 实时流式响应

**示例 - Playwright E2E**：

```typescript
// tests/e2e/chat-flow.spec.ts
import { test, expect } from '@playwright/test'

test.describe('Chat Flow', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/login')
    await page.fill('[data-testid="email"]', 'test@example.com')
    await page.fill('[data-testid="password"]', 'password123')
    await page.click('[data-testid="login-button"]')
    await page.waitForURL('/dashboard')
  })

  test('should complete a chat conversation', async ({ page }) => {
    // 选择 Agent
    await page.click('[data-testid="agent-card"]:first-child')

    // 发送消息
    await page.fill('[data-testid="chat-input"]', '你好，请介绍一下自己')
    await page.click('[data-testid="send-button"]')

    // 等待响应
    await expect(page.locator('[data-testid="assistant-message"]')).toBeVisible({
      timeout: 30000
    })

    // 验证响应内容
    const response = await page.textContent('[data-testid="assistant-message"]')
    expect(response).toBeTruthy()
    expect(response!.length).toBeGreaterThan(10)
  })

  test('should handle streaming response', async ({ page }) => {
    await page.click('[data-testid="agent-card"]:first-child')
    await page.fill('[data-testid="chat-input"]', '写一首关于 AI 的诗')
    await page.click('[data-testid="send-button"]')

    // 验证流式响应动画
    await expect(page.locator('[data-testid="typing-indicator"]')).toBeVisible()

    // 等待完成
    await expect(page.locator('[data-testid="typing-indicator"]')).not.toBeVisible({
      timeout: 60000
    })
  })
})
```

### 3.4 Agent 测试

**目标**：测试 Agent 执行逻辑、状态转换和工具调用。

**技术栈**：
- pytest + pytest-asyncio
- Mock LLM 响应
- 执行回放 (Replay Testing)

**覆盖范围**：
- 状态机流转
- Tool/Skill 调用
- SubAgent 委派
- 错误处理和重试

**示例 - Agent 状态机测试**：

```python
# tests/runtime/test_orchestrator.py
import pytest
from unittest.mock import AsyncMock, patch
from runtime.orchestrator import AgentExecutor, AgentState

@pytest.fixture
def mock_llm():
    with patch('runtime.llm.get_provider') as mock:
        provider = AsyncMock()
        mock.return_value = provider
        yield provider

@pytest.fixture
def agent_executor(mock_llm):
    config = {
        "model": "gpt-4o",
        "max_iterations": 5
    }
    return AgentExecutor(config)

class TestAgentExecutor:
    @pytest.mark.asyncio
    async def test_simple_response(self, agent_executor, mock_llm):
        """简单问题应直接响应，不调用工具"""
        mock_llm.chat.return_value = {
            "content": "2+2 等于 4",
            "tool_calls": None
        }

        state = AgentState(
            messages=[{"role": "user", "content": "2+2 等于多少？"}],
            iteration=0
        )

        result = await agent_executor.run(state)

        assert result["messages"][-1]["role"] == "assistant"
        assert "4" in result["messages"][-1]["content"]

    @pytest.mark.asyncio
    async def test_tool_execution(self, agent_executor, mock_llm):
        """需要工具的问题应触发工具调用"""
        # 第一次调用返回工具调用请求
        mock_llm.chat.side_effect = [
            {
                "content": "",
                "tool_calls": [{
                    "id": "call_1",
                    "function": {"name": "web_search", "arguments": '{"query": "AI news"}'}
                }]
            },
            # 第二次调用返回最终响应
            {
                "content": "根据搜索结果，最新的 AI 新闻是...",
                "tool_calls": None
            }
        ]

        state = AgentState(
            messages=[{"role": "user", "content": "搜索最新的 AI 新闻"}],
            iteration=0
        )

        with patch('runtime.tools.ToolRegistry.execute') as mock_tool:
            mock_tool.return_value = {"results": ["AI News 1", "AI News 2"]}
            result = await agent_executor.run(state)

        mock_tool.assert_called_once()
        assert "AI" in result["messages"][-1]["content"]

    @pytest.mark.asyncio
    async def test_max_iterations_limit(self, agent_executor, mock_llm):
        """应该遵守最大迭代次数限制"""
        # 每次都返回需要继续执行的状态
        mock_llm.chat.return_value = {
            "content": "",
            "tool_calls": [{"id": "call_1", "function": {"name": "search", "arguments": "{}"}}]
        }

        state = AgentState(
            messages=[{"role": "user", "content": "复杂任务"}],
            iteration=0
        )

        with patch('runtime.tools.ToolRegistry.execute') as mock_tool:
            mock_tool.return_value = {"status": "continue"}
            result = await agent_executor.run(state)

        assert result["iteration"] <= 5
```

**示例 - 执行回放测试**：

```python
# tests/runtime/test_replay.py
import pytest
import json
from pathlib import Path
from runtime.orchestrator import AgentExecutor

# 从真实执行中录制的会话
REPLAY_FIXTURES = Path(__file__).parent / "fixtures" / "replays"

class TestReplayExecution:
    @pytest.mark.asyncio
    @pytest.mark.parametrize("replay_file", list(REPLAY_FIXTURES.glob("*.json")))
    async def test_replay_session(self, replay_file):
        """回放录制的执行会话，验证结果一致性"""
        with open(replay_file) as f:
            replay = json.load(f)

        executor = AgentExecutor(replay["config"])

        # 使用录制的 LLM 响应
        with patch('runtime.llm.get_provider') as mock_llm:
            mock_llm.return_value.chat.side_effect = replay["llm_responses"]

            result = await executor.run(replay["initial_state"])

        # 验证关键断言
        assert result["messages"][-1]["content"] == replay["expected_response"]
        assert result["tool_results"] == replay["expected_tool_results"]
```

### 3.5 性能测试

**目标**：验证系统在高负载下的稳定性和响应时间。

**技术栈**：
- k6 (负载测试)
- Artillery (API 压测)

**覆盖范围**：
- API 响应时间
- 并发处理能力
- 资源使用情况

**示例 - k6 负载测试**：

```javascript
// tests/performance/chat-load.js
import http from 'k6/http'
import { check, sleep } from 'k6'
import { Rate, Trend } from 'k6/metrics'

const errorRate = new Rate('errors')
const chatLatency = new Trend('chat_latency')

export const options = {
  stages: [
    { duration: '1m', target: 10 },   // 预热
    { duration: '5m', target: 50 },   // 正常负载
    { duration: '2m', target: 100 },  // 峰值负载
    { duration: '1m', target: 0 },    // 冷却
  ],
  thresholds: {
    'http_req_duration': ['p(95)<5000'],  // 95% 请求 < 5s
    'errors': ['rate<0.01'],               // 错误率 < 1%
  },
}

const BASE_URL = __ENV.API_URL || 'https://api.semibot.dev'
const API_KEY = __ENV.API_KEY

export default function () {
  // 创建会话
  const sessionRes = http.post(
    `${BASE_URL}/v1/sessions`,
    JSON.stringify({ agent_id: 'agent_test' }),
    {
      headers: {
        'Authorization': `Bearer ${API_KEY}`,
        'Content-Type': 'application/json',
      },
    }
  )

  check(sessionRes, {
    'session created': (r) => r.status === 201,
  })

  if (sessionRes.status !== 201) {
    errorRate.add(1)
    return
  }

  const session = JSON.parse(sessionRes.body).data

  // 发送消息
  const startTime = Date.now()
  const chatRes = http.post(
    `${BASE_URL}/v1/chat`,
    JSON.stringify({
      session_id: session.id,
      message: '你好，请简单介绍一下自己',
      stream: false,
    }),
    {
      headers: {
        'Authorization': `Bearer ${API_KEY}`,
        'Content-Type': 'application/json',
      },
      timeout: '30s',
    }
  )

  chatLatency.add(Date.now() - startTime)

  check(chatRes, {
    'chat response ok': (r) => r.status === 200,
    'has content': (r) => JSON.parse(r.body).data?.content?.length > 0,
  })

  errorRate.add(chatRes.status !== 200 ? 1 : 0)

  sleep(1)
}
```

## 4. 测试配置

### 4.1 Node.js 配置 (vitest.config.ts)

```typescript
import { defineConfig } from 'vitest/config'
import path from 'path'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/e2e/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: [
        'node_modules/',
        'tests/',
        '**/*.d.ts',
        '**/*.config.*',
      ],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 75,
        statements: 80,
      },
    },
    setupFiles: ['./tests/setup.ts'],
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
})
```

### 4.2 Python 配置 (pytest.ini)

```ini
[pytest]
testpaths = tests
python_files = test_*.py
python_classes = Test*
python_functions = test_*
asyncio_mode = auto
addopts =
    -v
    --tb=short
    --cov=runtime
    --cov-report=term-missing
    --cov-report=html
    --cov-fail-under=80

markers =
    unit: Unit tests
    integration: Integration tests
    e2e: End-to-end tests
    slow: Slow running tests
```

### 4.3 Playwright 配置 (playwright.config.ts)

```typescript
import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: 'html',
  use: {
    baseURL: process.env.BASE_URL || 'http://localhost:3000',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'Mobile Safari',
      use: { ...devices['iPhone 12'] },
    },
  ],
  webServer: {
    command: 'pnpm dev',
    url: 'http://localhost:3000',
    reuseExistingServer: !process.env.CI,
  },
})
```

## 5. CI/CD 集成

### 5.1 GitHub Actions 工作流

```yaml
# .github/workflows/test.yml
name: Tests

on:
  push:
    branches: [main, develop]
  pull_request:
    branches: [main]

jobs:
  unit-tests:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'pnpm'

      - name: Install dependencies
        run: pnpm install --frozen-lockfile

      - name: Run unit tests
        run: pnpm test:unit

      - name: Upload coverage
        uses: codecov/codecov-action@v3
        with:
          files: ./coverage/lcov.info
          flags: unit

  integration-tests:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: pgvector/pgvector:pg16
        env:
          POSTGRES_USER: test
          POSTGRES_PASSWORD: test
          POSTGRES_DB: semibot_test
        ports:
          - 5432:5432
        options: >-
          --health-cmd pg_isready
          --health-interval 10s
          --health-timeout 5s
          --health-retries 5
      redis:
        image: redis:7-alpine
        ports:
          - 6379:6379
    steps:
      - uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'pnpm'

      - name: Install dependencies
        run: pnpm install --frozen-lockfile

      - name: Run migrations
        run: pnpm db:migrate
        env:
          DATABASE_URL: postgresql://test:test@localhost:5432/semibot_test

      - name: Run integration tests
        run: pnpm test:integration
        env:
          DATABASE_URL: postgresql://test:test@localhost:5432/semibot_test
          REDIS_URL: redis://localhost:6379

  python-tests:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Setup Python
        uses: actions/setup-python@v5
        with:
          python-version: '3.11'
          cache: 'pip'

      - name: Install dependencies
        run: |
          cd runtime
          pip install -r requirements.txt
          pip install -r requirements-dev.txt

      - name: Run pytest
        run: |
          cd runtime
          pytest --cov --cov-report=xml

      - name: Upload coverage
        uses: codecov/codecov-action@v3
        with:
          files: ./runtime/coverage.xml
          flags: python

  e2e-tests:
    runs-on: ubuntu-latest
    needs: [unit-tests, integration-tests]
    steps:
      - uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'pnpm'

      - name: Install dependencies
        run: pnpm install --frozen-lockfile

      - name: Install Playwright
        run: pnpm exec playwright install --with-deps

      - name: Run E2E tests
        run: pnpm test:e2e
        env:
          BASE_URL: ${{ secrets.STAGING_URL }}

      - name: Upload artifacts
        uses: actions/upload-artifact@v4
        if: failure()
        with:
          name: playwright-report
          path: playwright-report/
```

## 6. 测试数据管理

### 6.1 Fixtures 目录结构

```text
tests/
├── fixtures/
│   ├── agents/           # Agent 配置 fixtures
│   ├── sessions/         # 会话 fixtures
│   ├── replays/          # 执行回放数据
│   └── mocks/            # Mock 响应数据
├── helpers/
│   ├── db.ts             # 数据库帮助函数
│   ├── auth.ts           # 认证帮助函数
│   └── factories.ts      # 数据工厂
└── setup.ts              # 全局 setup
```

### 6.2 数据工厂示例

```typescript
// tests/helpers/factories.ts
import { faker } from '@faker-js/faker'

export const createAgent = (overrides = {}) => ({
  id: `agent_${faker.string.alphanumeric(10)}`,
  name: faker.company.name() + ' Assistant',
  system_prompt: faker.lorem.paragraph(),
  config: {
    model: 'gpt-4o',
    temperature: 0.7,
    max_tokens: 4096,
  },
  skills: [],
  sub_agents: [],
  is_active: true,
  created_at: new Date().toISOString(),
  ...overrides,
})

export const createSession = (agentId: string, overrides = {}) => ({
  id: `session_${faker.string.alphanumeric(10)}`,
  agent_id: agentId,
  user_id: `user_${faker.string.alphanumeric(10)}`,
  status: 'active',
  started_at: new Date().toISOString(),
  ...overrides,
})

export const createMessage = (sessionId: string, role: string, overrides = {}) => ({
  id: `msg_${faker.string.alphanumeric(10)}`,
  session_id: sessionId,
  role,
  content: faker.lorem.sentences(2),
  created_at: new Date().toISOString(),
  ...overrides,
})
```

## 7. Mock 策略

### 7.1 LLM Mock

```typescript
// tests/mocks/llm.ts
export const mockLLMResponses = {
  simple_greeting: {
    content: "你好！我是一个 AI 助手，很高兴为您服务。",
    tool_calls: null,
    usage: { prompt_tokens: 10, completion_tokens: 20 }
  },

  tool_call: {
    content: "",
    tool_calls: [{
      id: "call_123",
      type: "function",
      function: {
        name: "web_search",
        arguments: '{"query": "test query"}'
      }
    }],
    usage: { prompt_tokens: 15, completion_tokens: 5 }
  },

  error_response: {
    error: {
      type: "rate_limit_error",
      message: "Rate limit exceeded"
    }
  }
}
```

### 7.2 外部服务 Mock

```typescript
// tests/mocks/services.ts
import { setupServer } from 'msw/node'
import { http, HttpResponse } from 'msw'

export const mockServer = setupServer(
  // OpenAI API Mock
  http.post('https://api.openai.com/v1/chat/completions', () => {
    return HttpResponse.json({
      id: 'chatcmpl-123',
      choices: [{
        message: { role: 'assistant', content: 'Mock response' }
      }],
      usage: { prompt_tokens: 10, completion_tokens: 20 }
    })
  }),

  // 外部搜索 API Mock
  http.get('https://api.search.example.com/search', ({ request }) => {
    const url = new URL(request.url)
    const query = url.searchParams.get('q')
    return HttpResponse.json({
      results: [
        { title: `Result for: ${query}`, url: 'https://example.com' }
      ]
    })
  })
)
```

## 8. 测试命令

```bash
# 运行所有测试
pnpm test

# 单元测试
pnpm test:unit

# 集成测试
pnpm test:integration

# E2E 测试
pnpm test:e2e

# 带覆盖率
pnpm test:coverage

# 监听模式
pnpm test:watch

# Python 测试
cd runtime && pytest

# Python 特定测试
cd runtime && pytest tests/unit -v

# 性能测试
k6 run tests/performance/chat-load.js
```

## 9. 测试最佳实践

### 9.1 命名规范

- 测试文件：`*.test.ts` / `test_*.py`
- 测试描述：使用 `should` 开头描述预期行为
- 测试用例：一个用例只测试一个行为

### 9.2 AAA 模式

```typescript
it('should create agent successfully', async () => {
  // Arrange - 准备测试数据
  const agentData = createAgent({ name: 'Test Agent' })

  // Act - 执行被测试的操作
  const result = await agentService.create(agentData)

  // Assert - 验证结果
  expect(result.name).toBe('Test Agent')
  expect(result.id).toBeDefined()
})
```

### 9.3 测试隔离

- 每个测试用例独立运行
- 使用 `beforeEach` 重置状态
- 避免测试间的数据依赖
- 使用事务回滚清理数据

### 9.4 Mock 原则

- 只 mock 外部依赖（LLM、第三方 API）
- 不 mock 被测试的核心逻辑
- 确保 mock 行为与真实行为一致
- 定期验证 mock 与真实 API 的兼容性
