# Skills 管理与使用规范 - 两层模型设计

## 概述

本文档定义 Semibot 平台的 Skills 管理架构，引入 **SkillDefinition**（技能定义）和 **SkillPackage**（技能包）两层模型，实现"管理员统一管理、全租户共享、执行上下文隔离"的目标。

## 设计目标

1. **职责分离**：管理语义（Definition）与执行语义（Package）分离
2. **版本管理**：支持多版本共存、版本锁定、回滚
3. **全租户共享**：管理员统一管理，所有租户可见可用
4. **执行隔离**：执行时按 org/session/user 隔离上下文
5. **可追溯性**：完整记录来源、版本、校验值、安装日志

## 两层模型

### 1. SkillDefinition（技能定义层）

**职责**：平台级逻辑定义，描述"这是什么技能"

**特性**：
- 管理员统一 CRUD
- 全租户可见（`is_public = true`）
- 不包含具体执行代码
- 维护当前激活版本指针

**数据模型**：

```typescript
interface SkillDefinition {
  id: string                    // 技能定义唯一标识
  skillId: string               // 技能标识符（全局唯一，如 text-editor）
  name: string                  // 技能名称
  description?: string          // 技能描述
  triggerKeywords: string[]     // 触发关键词
  category?: string             // 技能分类
  tags: string[]                // 标签
  iconUrl?: string              // 图标 URL
  author?: string               // 作者
  homepageUrl?: string          // 主页 URL
  documentationUrl?: string     // 文档 URL
  currentVersion?: string       // 当前激活版本（指向 SkillPackage.version）
  isActive: boolean             // 是否启用
  isPublic: boolean             // 是否公开（全租户可见）
  createdBy?: string            // 创建者 ID
  createdAt: string             // 创建时间
  updatedAt: string             // 更新时间
}
```

**生命周期**：
1. 管理员创建 SkillDefinition
2. 管理员安装/发布 SkillPackage 版本
3. 系统自动更新 `currentVersion` 指针
4. 所有租户可见并使用

**权限控制**：
- 创建/更新/删除：仅管理员
- 查看：所有租户
- 使用：所有租户（通过 Agent 绑定）

---

### 2. SkillPackage（技能包层）

**职责**：可执行目录包，描述"如何执行这个技能"

**特性**：
- 按版本存储（一个 Definition 对应多个 Package）
- 包含完整可执行代码和资源
- 可追溯来源、校验值、安装日志
- 支持状态机管理（pending → downloading → validating → installing → active）

**数据模型**：

```typescript
interface SkillPackage {
  id: string                        // 包记录唯一标识
  skillDefinitionId: string         // 关联的技能定义 ID
  version: string                   // 版本号（语义化版本，如 1.0.0）
  sourceType: SkillSourceType       // 来源类型（git/url/registry/local/anthropic）
  sourceUrl?: string                // 来源 URL
  sourceRef?: string                // 来源引用（git commit/tag/branch）
  manifestUrl?: string              // Manifest URL
  manifestContent?: object          // Manifest 内容（完整 JSON）
  packagePath: string               // 包存储路径（相对于 SKILLS_STORAGE_ROOT）
  checksumSha256: string            // SHA256 校验值
  fileSizeBytes?: number            // 包文件大小（字节）
  status: SkillPackageStatus        // 状态
  validationResult?: object         // 校验结果
  tools: SkillToolInput[]           // 工具配置列表
  config: object                    // 包配置
  installedAt?: string              // 安装完成时间
  installedBy?: string              // 安装者 ID
  deprecatedAt?: string             // 废弃时间
  deprecatedReason?: string         // 废弃原因
  createdAt: string                 // 创建时间
  updatedAt: string                 // 更新时间
}
```

**状态机**：

```
pending → downloading → validating → installing → active
   ↓           ↓            ↓            ↓
failed ← ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ┘
   ↓
deprecated (手动废弃)
```

**目录结构**：

```
{SKILLS_STORAGE_ROOT}/
├── {skillId}/
│   ├── 1.0.0/
│   │   ├── SKILL.md          # 必需：技能说明文档
│   │   ├── manifest.json     # 必需：元数据清单
│   │   ├── scripts/          # 可选：可执行脚本
│   │   │   ├── main.py
│   │   │   └── utils.js
│   │   ├── references/       # 可选：参考文档
│   │   │   └── api-docs.md
│   │   └── assets/           # 可选：资源文件
│   │       └── icon.png
│   ├── 1.1.0/
│   │   └── ...
│   └── 2.0.0/
│       └── ...
```

**校验规则**：
1. 必需文件：`SKILL.md`
2. 推荐文件：`manifest.json`
3. 可选目录：`scripts/`, `references/`, `assets/`
4. 入口文件：从 manifest 或约定路径解析
5. SHA256 校验：确保包完整性

---

## 职责边界

| 维度 | SkillDefinition | SkillPackage |
|------|----------------|--------------|
| **管理对象** | 技能的逻辑定义 | 技能的可执行代码 |
| **管理者** | 管理员 | 管理员 |
| **可见性** | 全租户可见 | 全租户可见（通过 Definition） |
| **版本** | 维护当前版本指针 | 存储具体版本实现 |
| **生命周期** | 长期存在 | 可被废弃/回滚 |
| **存储内容** | 元数据（名称、描述、分类） | 代码、资源、配置 |
| **执行** | 不可执行 | 可执行 |
| **变更频率** | 低（仅元数据变更） | 高（版本迭代） |
| **删除影响** | 删除所有版本 | 仅影响该版本 |

---

## ��联关系

### 1. SkillDefinition ↔ SkillPackage

**关系**：一对多（一个 Definition 对应多个 Package 版本）

```typescript
// 查询技能的所有版本
const packages = await db.query(
  'SELECT * FROM skill_packages WHERE skill_definition_id = $1 ORDER BY created_at DESC',
  [definitionId]
)

// 查询技能的当前激活版本
const activePackage = await db.query(
  `SELECT sp.* FROM skill_packages sp
   JOIN skill_definitions sd ON sd.id = sp.skill_definition_id
   WHERE sd.id = $1 AND sp.version = sd.current_version AND sp.status = 'active'`,
  [definitionId]
)
```

### 2. Agent ↔ SkillDefinition

**关系**：多对多（通过 `agent_skills` 表）

```typescript
// Agent 绑定 Skill（支持版本锁定）
interface AgentSkillBinding {
  agentId: string
  skillDefinitionId: string     // 绑定到 Definition
  versionLock?: string          // 可选：版本锁定（如 1.0.0, ^1.2.0, ~1.2.3）
  autoUpdate: boolean           // 是否自动更新到最新版本
  priority: number              // 优先级
  config?: object               // 覆盖配置
}
```

**版本解析规则**：
- `versionLock` 为空 + `autoUpdate = true`：使用 `currentVersion`
- `versionLock = "1.0.0"`：锁定到 1.0.0
- `versionLock = "^1.2.0"`：兼容 1.x.x（>=1.2.0, <2.0.0）
- `versionLock = "~1.2.3"`：兼容 1.2.x（>=1.2.3, <1.3.0）

### 3. SkillPackage ↔ SkillInstallLog

**关系**：一对多（一个 Package 对应多条安装日志）

```typescript
// 查询安装历史
const logs = await db.query(
  'SELECT * FROM skill_install_logs WHERE skill_package_id = $1 ORDER BY created_at DESC',
  [packageId]
)

// 查询最后一次安装日志
const lastLog = await db.query(
  'SELECT * FROM skill_install_logs WHERE skill_package_id = $1 ORDER BY created_at DESC LIMIT 1',
  [packageId]
)
```

---

## 安装流程

### 统一安装状态机

```
[入口] → [拉取 Manifest] → [校验字段] → [下载包] → [校验目录] → [记录数据库] → [激活]
  ↓            ↓               ↓           ↓          ↓             ↓            ↓
[失败] ← ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ┘
  ↓
[重试/回滚]
```

### 三种安装入口

#### 1. 手动输入 skill_id

```typescript
POST /api/v1/skills/install
{
  "skillId": "text-editor",
  "version": "1.0.0",
  "sourceType": "anthropic"
}
```

#### 2. 通过 manifest_url

```typescript
POST /api/v1/skills/install/manifest
{
  "manifestUrl": "https://example.com/skills/text-editor/manifest.json"
}
```

#### 3. 通过 catalog 发现

```typescript
// 1. 获取目录
GET /api/v1/skills/catalog/anthropic

// 2. 选择并安装
POST /api/v1/skills/install
{
  "skillId": "text-editor",
  "version": "1.0.0",
  "sourceType": "anthropic"
}
```

### 安装步骤（原子化）

```typescript
async function installSkillPackage(input: InstallSkillPackageInput): Promise<SkillPackage> {
  const log = await createInstallLog({
    operation: 'install',
    status: 'pending',
  })

  try {
    // 1. 拉取 Manifest
    await updateLog(log.id, { step: 'fetch_manifest', progress: 10 })
    const manifest = await fetchManifest(input.manifestUrl)

    // 2. 校验字段
    await updateLog(log.id, { step: 'validate_manifest', progress: 20 })
    validateManifest(manifest)

    // 3. 下载包
    await updateLog(log.id, { step: 'download', progress: 30 })
    const packagePath = await downloadPackage(manifest.sourceUrl)

    // 4. 计算校验值
    await updateLog(log.id, { step: 'checksum', progress: 50 })
    const checksum = await calculateSHA256(packagePath)

    // 5. 校验目录结构
    await updateLog(log.id, { step: 'validate_structure', progress: 60 })
    const validationResult = await validatePackageStructure(packagePath)

    // 6. 记录到数据库
    await updateLog(log.id, { step: 'save_db', progress: 80 })
    const pkg = await db.skillPackages.create({
      ...input,
      packagePath,
      checksumSha256: checksum,
      validationResult,
      status: 'active',
      installedAt: new Date(),
    })

    // 7. 更新 Definition 的 currentVersion
    await updateLog(log.id, { step: 'activate', progress: 90 })
    await db.skillDefinitions.update(input.skillDefinitionId, {
      currentVersion: input.version,
    })

    // 8. 完成
    await updateLog(log.id, {
      status: 'success',
      progress: 100,
      completedAt: new Date(),
    })

    return pkg
  } catch (error) {
    // 失败处理
    await updateLog(log.id, {
      status: 'failed',
      errorCode: error.code,
      errorMessage: error.message,
      errorStack: error.stack,
      completedAt: new Date(),
    })

    // 清理失败的包文件
    await cleanupFailedPackage(packagePath)

    throw error
  }
}
```

---

## 版本管理

### 发布新版本

```typescript
POST /api/v1/skills/:id/publish
{
  "version": "1.1.0",
  "sourceType": "git",
  "sourceUrl": "https://github.com/org/skill-text-editor.git",
  "sourceRef": "v1.1.0",
  "releaseNotes": "Added syntax highlighting support"
}
```

**流程**：
1. 创建新的 SkillPackage 记录（status = 'pending'）
2. 执行安装流程
3. 安装成功后，更新 Definition 的 `currentVersion`
4. 旧版本保持 `status = 'active'`（支持回滚）

### 查询版本列表

```typescript
GET /api/v1/skills/:id/versions

Response:
{
  "success": true,
  "data": [
    {
      "version": "2.0.0",
      "status": "active",
      "isCurrent": true,
      "installedAt": "2026-02-09T10:00:00Z"
    },
    {
      "version": "1.1.0",
      "status": "active",
      "isCurrent": false,
      "installedAt": "2026-02-08T10:00:00Z"
    },
    {
      "version": "1.0.0",
      "status": "deprecated",
      "isCurrent": false,
      "installedAt": "2026-02-07T10:00:00Z",
      "deprecatedAt": "2026-02-09T10:00:00Z"
    }
  ]
}
```

### 回滚版本

```typescript
POST /api/v1/skills/:id/rollback
{
  "targetVersion": "1.1.0",
  "reason": "Critical bug in 2.0.0"
}
```

**流程**：
1. 验证目标版本存在且 `status = 'active'`
2. 更新 Definition 的 `currentVersion` 为目标版本
3. 可选：将当前版本标记为 `deprecated`
4. 记录回滚日志

---

## 执行上下文隔离

虽然 Skills 全租户共享，但执行时必须隔离上下文：

### 1. 上下文传递

```typescript
interface SkillExecutionContext {
  orgId: string           // 组织 ID
  sessionId: string       // 会话 ID
  userId: string          // 用户 ID
  agentId: string         // Agent ID
  skillDefinitionId: string
  skillPackageId: string
  version: string
}
```

### 2. 缓存键隔离

```typescript
// ❌ 错误：全局缓存键
const cacheKey = `skill:${skillId}:result`

// ✅ 正确：按 org 隔离
const cacheKey = `skill:${orgId}:${skillId}:result`
```

### 3. 临时文件隔���

```typescript
// ❌ 错误：共享临时目���
const tempDir = `/tmp/skills/${skillId}`

// ✅ 正确：按 org 隔离
const tempDir = `/tmp/skills/${orgId}/${skillId}`
```

### 4. 审计日志聚合

```typescript
// 按 org 查询技能使用日志
SELECT * FROM skill_execution_logs
WHERE org_id = $1 AND skill_definition_id = $2
ORDER BY created_at DESC
```

---

## 安全与隔离

### 1. 路径穿越防护

```typescript
function validatePackagePath(path: string): void {
  const normalized = path.normalize(path)
  const storageRoot = process.env.SKILLS_STORAGE_ROOT

  if (!normalized.startsWith(storageRoot)) {
    throw new Error('Path traversal detected')
  }
}
```

### 2. Sandbox 执行

```typescript
// 技能执行必须在沙箱环境中
async function executeSkill(context: SkillExecutionContext, input: unknown) {
  const sandbox = await createSandbox({
    orgId: context.orgId,
    allowedPaths: [context.packagePath],
    timeout: 30000,
    memoryLimit: '512MB',
  })

  try {
    return await sandbox.execute(input)
  } finally {
    await sandbox.cleanup()
  }
}
```

### 3. 权限策略

```typescript
// 技能执行权限策略
interface SkillPermissionPolicy {
  allowNetworkAccess: boolean
  allowFileSystemRead: boolean
  allowFileSystemWrite: boolean
  allowedDomains: string[]
  allowedPaths: string[]
}
```

---

## 数据迁移策略

### 从旧模型迁移

```sql
-- 1. 迁移 skills → skill_definitions
INSERT INTO skill_definitions (...)
SELECT ... FROM skills

-- 2. 为每个 skill 创建初始 package（版本 1.0.0）
INSERT INTO skill_packages (...)
SELECT ... FROM skills

-- 3. 更新 agent_skills 关联
UPDATE agent_skills
SET skill_definition_id = (SELECT id FROM skill_definitions WHERE ...)

-- 4. 标记迁移完成
UPDATE skills SET migration_status = 'completed'
```

### 向后兼容

- 保留 `skills` 表用于向后兼容（可选）
- API 路由同时支持新旧模型
- 前端逐步迁移到新模型

---

## 总结

### SkillDefinition（技能定义）

- **是什么**：技能的逻辑定义和元数据
- **谁管理**：管理员
- **谁可见**：全租户
- **包含什么**：名称、描述、分类、当前版本指针
- **生命周期**：长期存在

### SkillPackage（技能包）

- **是什么**：技能的可执行代码和资源
- **谁管理**：管理员
- **谁可见**：全租户（通过 Definition）
- **包含什么**：代码、配置、工具、校验值
- **生命周期**：可被废弃、回滚、替换

### 关键原则

1. **职责分离**：管理与执行分离
2. **版本管理**：支持多版本共存
3. **全租户共享**：管理员统一管理
4. **执行隔离**：按 org/session/user 隔离
5. **可追溯性**：完整记录来源和变更历史
