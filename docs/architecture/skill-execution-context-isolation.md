# Skills 执行上下文隔离规范

## 概述

虽然 Skills 在平台层面全租户共享（管理员统一管理，所有租户可见），但在执行层面必须严格隔离各租户的上下文，确保数据安全和隐私保护。

本文档定义执行上下文隔离的规范和实施细节。

## 设计原则

1. **全租户共享**：Skills 定义和代码包对所有租户可见
2. **执行隔离**：每次执行必须携带完整的上下文信息（org/session/user）
3. **命名空间隔离**：缓存、临时文件、日志按 org 命名空间隔离
4. **审计可追溯**：所有执行记录必须关联到具体租户和用户
5. **零信任原则**：不依赖隐式上下文，所有上下文必须显式传递

## 执行上下文定义

### 1. 核心上下文对象

```typescript
/**
 * Skill 执行上下文
 *
 * 所有 Skill 执行必须携带此上下文对象
 */
interface SkillExecutionContext {
  // === 租户隔离 ===
  /** 组织 ID（必需） */
  orgId: string

  // === 会话追踪 ===
  /** 会话 ID（必需） */
  sessionId: string

  /** 消息 ID（可选，用于关联具体消息） */
  messageId?: string

  // === 用户身份 ===
  /** 用户 ID（必需） */
  userId: string

  /** 用户角色（可选） */
  userRole?: string

  // === Agent 信息 ===
  /** Agent ID（必需） */
  agentId: string

  /** Agent 名称（可选，用于日志） */
  agentName?: string

  // === Skill 信息 ===
  /** Skill Definition ID（必需） */
  skillDefinitionId: string

  /** Skill Package ID（必需） */
  skillPackageId: string

  /** Skill 版本（必需） */
  version: string

  /** Skill 标识符（可选，用于日志） */
  skillId?: string

  // === 执行元数据 ===
  /** 执行 ID（唯一标识本次执行） */
  executionId: string

  /** 执行开始时间 */
  startedAt: Date

  /** 超时时间（毫秒） */
  timeout: number

  /** 重试次数 */
  retryCount: number

  // === 权限与配额 ===
  /** 权限策略 */
  permissions: SkillPermissionPolicy

  /** 配额限制 */
  quotas: SkillQuotaLimits
}

/**
 * Skill 权限策略
 */
interface SkillPermissionPolicy {
  /** 是否允许网络访问 */
  allowNetworkAccess: boolean

  /** 是否允许文件系统读取 */
  allowFileSystemRead: boolean

  /** 是否允许文件系统写入 */
  allowFileSystemWrite: boolean

  /** 允许访问的域名列表 */
  allowedDomains: string[]

  /** 允许访问的路径列表 */
  allowedPaths: string[]

  /** 是否允许执行外部命令 */
  allowExecCommands: boolean

  /** 允许的环境变量列表 */
  allowedEnvVars: string[]
}

/**
 * Skill 配额限制
 */
interface SkillQuotaLimits {
  /** 最大执行时间（毫秒） */
  maxExecutionTime: number

  /** 最大内存使用（字节） */
  maxMemoryBytes: number

  /** 最大 CPU 使用率（百分比） */
  maxCpuPercent: number

  /** 最大网络请求数 */
  maxNetworkRequests: number

  /** 最大文件读取大小（字节） */
  maxFileReadBytes: number

  /** 最大文件写入大小（字节） */
  maxFileWriteBytes: number
}
```

### 2. 上下文传递规范

**规则**：
- 所有 Skill 执行入口必须接收 `SkillExecutionContext` 参数
- 上下文对象必须在整个调用链中传递
- 禁止使用全局变量或线程本地存储传递上下文
- 禁止从环境变量或配置文件推断上下文

**示例**：

```typescript
// ✅ 正确：显式传递上下文
async function executeSkill(
  context: SkillExecutionContext,
  input: unknown
): Promise<unknown> {
  // 验证上下文
  validateContext(context)

  // 传递给下游函数
  const result = await runSkillCode(context, input)

  // 记录审计日志
  await logExecution(context, result)

  return result
}

// ❌ 错误：隐式上下文
async function executeSkill(input: unknown): Promise<unknown> {
  const orgId = process.env.ORG_ID  // 错误：从环境变量推断
  // ...
}
```

---

## 命名空间隔离

### 1. 缓存键隔离

**规则**：
- 所有缓存键必须包含 `orgId` 前缀
- 推荐格式：`skill:{orgId}:{skillId}:{key}`
- 禁止使用全局缓存键

**示例**：

```typescript
// ✅ 正确：按 org 隔离
function getCacheKey(context: SkillExecutionContext, key: string): string {
  return `skill:${context.orgId}:${context.skillId}:${key}`
}

// 使用示例
const cacheKey = getCacheKey(context, 'result')
await redis.set(cacheKey, result, 'EX', 300)

// ❌ 错误：全局缓存键
const cacheKey = `skill:${skillId}:result`  // 缺少 orgId
```

**Redis 命名空间示例**：

```
skill:{orgId}:{skillId}:config          # Skill 配置缓存
skill:{orgId}:{skillId}:result:{hash}   # 执行结果缓存
skill:{orgId}:{skillId}:state           # Skill 状态
skill:{orgId}:{skillId}:lock            # 分布式锁
```

### 2. 临时文件隔离

**规则**：
- 所有临时文件必须存储在 org 专属目录
- 推荐格式：`{TEMP_ROOT}/{orgId}/{skillId}/{executionId}/`
- 执行完成后必须清理临时文件

**示例**：

```typescript
// ✅ 正确：按 org 隔离
function getTempDir(context: SkillExecutionContext): string {
  const tempRoot = process.env.SKILLS_TEMP_ROOT || '/tmp/skills'
  return path.join(
    tempRoot,
    context.orgId,
    context.skillId,
    context.executionId
  )
}

// 使用示例
async function executeSkill(context: SkillExecutionContext, input: unknown) {
  const tempDir = getTempDir(context)

  try {
    // 创建临时目录
    await fs.mkdir(tempDir, { recursive: true })

    // 执行 Skill
    const result = await runSkillCode(context, input, tempDir)

    return result
  } finally {
    // 清理临时文件
    await fs.rm(tempDir, { recursive: true, force: true })
  }
}

// ❌ 错误：共享临时目录
const tempDir = `/tmp/skills/${skillId}`  // 缺少 orgId 和 executionId
```

**目录结构示例**：

```
/tmp/skills/
├── org-123/
│   ├── text-editor/
│   │   ├── exec-abc/
│   │   │   ├── input.txt
│   │   │   └── output.txt
│   │   └── exec-def/
│   │       └── ...
│   └── code-analyzer/
│       └── ...
└── org-456/
    └── ...
```

### 3. 日志隔离

**规则**：
- 所有日志必须包含 `orgId`、`userId`、`sessionId`
- 日志查询必须按 org 过滤
- 敏感信息必须脱敏

**示例**：

```typescript
// ✅ 正确：结构化日志
logger.info('Skill execution started', {
  orgId: context.orgId,
  userId: context.userId,
  sessionId: context.sessionId,
  agentId: context.agentId,
  skillId: context.skillId,
  version: context.version,
  executionId: context.executionId,
})

// 查询日志（按 org 过滤）
const logs = await db.query(
  `SELECT * FROM skill_execution_logs
   WHERE org_id = $1 AND skill_definition_id = $2
   ORDER BY created_at DESC
   LIMIT 100`,
  [orgId, skillDefinitionId]
)

// ❌ 错误：缺少上下文信息
logger.info('Skill execution started')  // 无法追溯到具体租户
```

### 4. 数据库隔离

**规则**：
- 所有数据库查询必须包含 `org_id` 过滤条件
- 使用 Row-Level Security (RLS) 强制隔离
- 审计日志必须记录 org_id

**示例**：

```typescript
// ✅ 正确：包含 org_id 过滤
async function getSkillExecutionHistory(
  context: SkillExecutionContext,
  limit: number = 100
): Promise<SkillExecutionLog[]> {
  return await db.query(
    `SELECT * FROM skill_execution_logs
     WHERE org_id = $1 AND skill_definition_id = $2
     ORDER BY created_at DESC
     LIMIT $3`,
    [context.orgId, context.skillDefinitionId, limit]
  )
}

// ❌ 错误：缺少 org_id 过滤
async function getSkillExecutionHistory(
  skillDefinitionId: string,
  limit: number = 100
): Promise<SkillExecutionLog[]> {
  return await db.query(
    `SELECT * FROM skill_execution_logs
     WHERE skill_definition_id = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [skillDefinitionId, limit]  // 跨租户数据泄露风险！
  )
}
```

**PostgreSQL Row-Level Security 示例**：

```sql
-- 启用 RLS
ALTER TABLE skill_execution_logs ENABLE ROW LEVEL SECURITY;

-- 创建策略：用户只能访问自己组织的数据
CREATE POLICY skill_execution_logs_org_isolation ON skill_execution_logs
  USING (org_id = current_setting('app.current_org_id')::uuid);

-- 应用层设置当前 org_id
SET app.current_org_id = 'org-123';
```

---

## 审计与追溯

### 1. 执行日志表

```sql
CREATE TABLE skill_execution_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- 租户隔离
    org_id UUID NOT NULL,

    -- 会话追踪
    session_id UUID NOT NULL,
    message_id UUID,

    -- 用户身份
    user_id UUID NOT NULL,

    -- Agent 信息
    agent_id UUID NOT NULL,

    -- Skill 信息
    skill_definition_id UUID NOT NULL,
    skill_package_id UUID NOT NULL,
    skill_id VARCHAR(120) NOT NULL,
    version VARCHAR(50) NOT NULL,

    -- 执行信息
    execution_id UUID NOT NULL UNIQUE,
    status VARCHAR(20) NOT NULL,  -- pending/running/success/failed/timeout
    input JSONB,
    output JSONB,
    error_code VARCHAR(50),
    error_message TEXT,

    -- 性能指标
    started_at TIMESTAMPTZ NOT NULL,
    completed_at TIMESTAMPTZ,
    duration_ms INTEGER,
    memory_used_bytes BIGINT,
    cpu_time_ms INTEGER,

    -- 资源使用
    network_requests_count INTEGER DEFAULT 0,
    file_reads_count INTEGER DEFAULT 0,
    file_writes_count INTEGER DEFAULT 0,

    -- 审计
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 索引
CREATE INDEX idx_skill_execution_logs_org ON skill_execution_logs(org_id);
CREATE INDEX idx_skill_execution_logs_session ON skill_execution_logs(session_id);
CREATE INDEX idx_skill_execution_logs_user ON skill_execution_logs(user_id);
CREATE INDEX idx_skill_execution_logs_skill ON skill_execution_logs(skill_definition_id);
CREATE INDEX idx_skill_execution_logs_created ON skill_execution_logs(created_at DESC);
```

### 2. 审计日志记录

```typescript
/**
 * 记录 Skill 执行审计日志
 */
async function logSkillExecution(
  context: SkillExecutionContext,
  status: 'success' | 'failed' | 'timeout',
  result: {
    output?: unknown
    error?: Error
    metrics: {
      durationMs: number
      memoryUsedBytes: number
      cpuTimeMs: number
      networkRequestsCount: number
      fileReadsCount: number
      fileWritesCount: number
    }
  }
): Promise<void> {
  await db.skillExecutionLogs.create({
    // 租户隔离
    orgId: context.orgId,

    // 会话追踪
    sessionId: context.sessionId,
    messageId: context.messageId,

    // 用户身份
    userId: context.userId,

    // Agent 信息
    agentId: context.agentId,

    // Skill 信息
    skillDefinitionId: context.skillDefinitionId,
    skillPackageId: context.skillPackageId,
    skillId: context.skillId,
    version: context.version,

    // 执行信息
    executionId: context.executionId,
    status,
    output: result.output,
    errorCode: result.error?.code,
    errorMessage: result.error?.message,

    // 性能指标
    startedAt: context.startedAt,
    completedAt: new Date(),
    durationMs: result.metrics.durationMs,
    memoryUsedBytes: result.metrics.memoryUsedBytes,
    cpuTimeMs: result.metrics.cpuTimeMs,

    // 资源使用
    networkRequestsCount: result.metrics.networkRequestsCount,
    fileReadsCount: result.metrics.fileReadsCount,
    fileWritesCount: result.metrics.fileWritesCount,
  })
}
```

### 3. 审计查询示例

```typescript
// 查询组织的 Skill 使用情况
async function getOrgSkillUsage(
  orgId: string,
  startDate: Date,
  endDate: Date
): Promise<SkillUsageStats[]> {
  return await db.query(
    `SELECT
       skill_definition_id,
       skill_id,
       COUNT(*) as execution_count,
       COUNT(CASE WHEN status = 'success' THEN 1 END) as success_count,
       COUNT(CASE WHEN status = 'failed' THEN 1 END) as failed_count,
       AVG(duration_ms) as avg_duration_ms,
       SUM(memory_used_bytes) as total_memory_bytes
     FROM skill_execution_logs
     WHERE org_id = $1
       AND created_at BETWEEN $2 AND $3
     GROUP BY skill_definition_id, skill_id
     ORDER BY execution_count DESC`,
    [orgId, startDate, endDate]
  )
}

// 查询用户的 Skill 使用历史
async function getUserSkillHistory(
  orgId: string,
  userId: string,
  limit: number = 50
): Promise<SkillExecutionLog[]> {
  return await db.query(
    `SELECT * FROM skill_execution_logs
     WHERE org_id = $1 AND user_id = $2
     ORDER BY created_at DESC
     LIMIT $3`,
    [orgId, userId, limit]
  )
}
```

---

## 安全隔离

### 1. Sandbox 执行环境

**规则**：
- 所有 Skill 必须在沙箱环境中执行
- 沙箱必须限制资源使用（CPU、内存、网络、文件系统）
- 沙箱必须按 org 隔离

**示例**：

```typescript
/**
 * 创建 Skill 执行沙箱
 */
async function createSkillSandbox(
  context: SkillExecutionContext
): Promise<SkillSandbox> {
  const tempDir = getTempDir(context)
  const packagePath = await getPackagePath(context.skillPackageId)

  return new SkillSandbox({
    // 上下文
    orgId: context.orgId,
    executionId: context.executionId,

    // 资源限制
    timeout: context.timeout,
    maxMemoryBytes: context.quotas.maxMemoryBytes,
    maxCpuPercent: context.quotas.maxCpuPercent,

    // 文件系统隔离
    allowedPaths: [
      packagePath,  // Skill 代码目录（只读）
      tempDir,      // 临时目录（读写）
      ...context.permissions.allowedPaths,
    ],
    readOnlyPaths: [packagePath],

    // 网络隔离
    allowNetworkAccess: context.permissions.allowNetworkAccess,
    allowedDomains: context.permissions.allowedDomains,
    maxNetworkRequests: context.quotas.maxNetworkRequests,

    // 环境变量隔离
    env: {
      ORG_ID: context.orgId,
      USER_ID: context.userId,
      SESSION_ID: context.sessionId,
      EXECUTION_ID: context.executionId,
      TEMP_DIR: tempDir,
      ...filterEnvVars(process.env, context.permissions.allowedEnvVars),
    },
  })
}

/**
 * 在沙箱中执行 Skill
 */
async function executeSkillInSandbox(
  context: SkillExecutionContext,
  input: unknown
): Promise<unknown> {
  const sandbox = await createSkillSandbox(context)

  try {
    const result = await sandbox.execute(input)
    return result
  } finally {
    await sandbox.cleanup()
  }
}
```

### 2. 权限检查

```typescript
/**
 * 验证 Skill 执行权限
 */
function validateSkillPermissions(
  context: SkillExecutionContext,
  requestedAction: string
): void {
  const { permissions } = context

  switch (requestedAction) {
    case 'network_access':
      if (!permissions.allowNetworkAccess) {
        throw new Error('Network access not allowed for this skill')
      }
      break

    case 'file_read':
      if (!permissions.allowFileSystemRead) {
        throw new Error('File system read not allowed for this skill')
      }
      break

    case 'file_write':
      if (!permissions.allowFileSystemWrite) {
        throw new Error('File system write not allowed for this skill')
      }
      break

    case 'exec_command':
      if (!permissions.allowExecCommands) {
        throw new Error('Command execution not allowed for this skill')
      }
      break

    default:
      throw new Error(`Unknown action: ${requestedAction}`)
  }
}
```

### 3. 配额检查

```typescript
/**
 * 检查 Skill 执行配额
 */
async function checkSkillQuota(
  context: SkillExecutionContext
): Promise<void> {
  const { orgId, skillDefinitionId } = context
  const { quotas } = context

  // 查询当前使用情况
  const usage = await getOrgSkillUsage(orgId, skillDefinitionId)

  // 检查执行次数配额
  if (usage.executionCount >= quotas.maxExecutionsPerDay) {
    throw new Error('Daily execution quota exceeded')
  }

  // 检查内存使用配额
  if (usage.totalMemoryBytes >= quotas.maxTotalMemoryBytes) {
    throw new Error('Memory quota exceeded')
  }

  // 检查并发执行数
  const concurrentExecutions = await getConcurrentExecutions(orgId, skillDefinitionId)
  if (concurrentExecutions >= quotas.maxConcurrentExecutions) {
    throw new Error('Concurrent execution limit reached')
  }
}
```

---

## 实施检查清单

### 开发阶段

- [ ] 所有 Skill 执行函数接收 `SkillExecutionContext` 参数
- [ ] 上下文在整个调用链中显式传递
- [ ] 缓存键包含 `orgId` 前缀
- [ ] 临时文件存储在 org 专属目录
- [ ] 日志包含完整上下文信息（orgId/userId/sessionId）
- [ ] 数据库查询包含 `org_id` 过滤条件
- [ ] 实现 Sandbox 执行环境
- [ ] 实现权限和配额检查

### 测试阶段

- [ ] 单元测试覆盖上下文传递
- [ ] 集成测试验证多租户隔离
- [ ] 安全测试验证跨租户数据访问防护
- [ ] 性能测试验证资源限制
- [ ] 审计日志完整性测试

### 部署阶段

- [ ] 配置环境变量（SKILLS_TEMP_ROOT 等）
- [ ] 启用数据库 Row-Level Security
- [ ] 配置监控和告警
- [ ] 编写运维文档

### 运维阶段

- [ ] 定期清理临时文件
- [ ] 监控资源使用情况
- [ ] 审计日志归档
- [ ] 配额调整和优化

---

## 常见问题

### Q1: 为什么不使用线程本地存储传递上下文？

**A**: 线程本地存储在异步环境中不可靠，容易导致上下文丢失或混乱。显式传递上下文更安全、更清晰。

### Q2: 如何处理第三方库不支持上下文传递？

**A**: 使用适配器模式包装第三方库，在适配器层注入上下文。

```typescript
// 适配器示例
class ContextAwareHttpClient {
  constructor(private context: SkillExecutionContext) {}

  async get(url: string): Promise<Response> {
    // 检查权限
    validateSkillPermissions(this.context, 'network_access')

    // 检查域名白名单
    if (!isAllowedDomain(url, this.context.permissions.allowedDomains)) {
      throw new Error('Domain not allowed')
    }

    // 添加追踪头
    const headers = {
      'X-Org-Id': this.context.orgId,
      'X-Execution-Id': this.context.executionId,
    }

    return await fetch(url, { headers })
  }
}
```

### Q3: 如何确保开发者遵守隔离规范？

**A**:
1. 使用 TypeScript 类型系统强制传递上下文
2. 使用 ESLint 规则检查缓存键格式
3. 使用代码审查检查隔离实现
4. 使用集成测试验证多租户隔离

### Q4: 性能开销如何？

**A**:
- 上下文传递：几乎无开销（仅传递引用）
- 命名空间隔离：微小开销（字符串拼接）
- Sandbox 执行：有一定开销，但安全性优先
- 审计日志：异步写入，不阻塞主流程

---

## 总结

执行上下文隔离是多租户 SaaS 平台的核心安全机制。通过：

1. **显式传递上下文**：确保所有执行都有明确的租户身份
2. **命名空间隔离**：缓存、文件、日志按 org 隔离
3. **Sandbox 执行**：限制资源使用和访问权限
4. **审计追溯**：完整记录所有执行历史

我们可以在全租户共享 Skills 的前提下，确保数据安全和隐私保护。
