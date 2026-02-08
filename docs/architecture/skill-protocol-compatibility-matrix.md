# Skills 协议兼容矩阵

## 概述

本文档定义 Semibot 平台与外部 Skills 协议（Anthropic Skills、Codex Skills）的兼容性规范，确保平台可以安装和执行来自不同来源的技能包。

## 设计目标

1. **协议对齐**：与 Anthropic/Codex 的目录型技能理念对齐
2. **最小兼容集**：定义平台内部最小兼容字段集
3. **自动化校验**：提供自动化校验脚本
4. **向后兼容**：支持协议演进和版本升级

## 协议对比

### 1. Anthropic Skills 协议

**官方文档**: https://docs.anthropic.com/en/docs/build-with-claude/skills

**核心特性**:
- 基于 `container.skills` 透传机制
- 支持 `skill_id` 和 `version` 引用
- 支持 Manifest URL 发现
- 支持 Catalog 目录

**Manifest 格式**:

```json
{
  "skill_id": "text-editor",
  "version": "1.0.0",
  "name": "Text Editor",
  "description": "Edit and manipulate text content",
  "trigger_keywords": ["edit", "text", "modify"],
  "author": "Anthropic",
  "homepage": "https://example.com/skills/text-editor",
  "documentation": "https://example.com/skills/text-editor/docs",
  "container": {
    "skills": [
      {
        "type": "anthropic",
        "skill_id": "text-editor",
        "version": "1.0.0"
      }
    ]
  }
}
```

**Catalog 格式**:

```json
{
  "skills": [
    {
      "skill_id": "text-editor",
      "name": "Text Editor",
      "description": "Edit and manipulate text content",
      "version": "1.0.0",
      "manifest_url": "https://example.com/skills/text-editor/manifest.json"
    }
  ]
}
```

---

### 2. Codex Skills 协议

**参考**: GitHub Copilot Skills, OpenAI Codex

**核心特性**:
- 基于目录结构的技能包
- 支持 `SKILL.md` 说明文档
- 支持 `scripts/` 可执行脚本
- 支持 `references/` 参考文档

**目录结构**:

```
skill-name/
├── SKILL.md              # 必需：技能说明文档
├── manifest.json         # 推荐：元数据清单
├── scripts/              # 可选：可执行脚本
│   ├── main.py
│   ├── utils.js
│   └── config.yaml
├── references/           # 可选：参考文档
│   ├── api-docs.md
│   └── examples.md
└── assets/               # 可选：资源文件
    ├── icon.png
    └── screenshot.png
```

**SKILL.md 格式**:

```markdown
---
skill_id: text-editor
version: 1.0.0
name: Text Editor
description: Edit and manipulate text content
trigger_keywords:
  - edit
  - text
  - modify
---

# Text Editor Skill

## Description

This skill allows you to edit and manipulate text content.

## Usage

...

## Examples

...
```

---

### 3. Semibot 平台内部协议

**核心特性**:
- 两层模型：SkillDefinition + SkillPackage
- 支持多版本管理
- 支持来源追溯和校验值
- 支持安装日志和状态机

**最小兼容字段集**:

```typescript
interface SemibotSkillManifest {
  // === 必需字段 ===
  skill_id: string          // 技能标识符（全局唯一）
  name: string              // 技能名称
  version: string           // 版本号（语义化版本）

  // === 推荐字段 ===
  description?: string      // 技能描述
  trigger_keywords?: string[]  // 触发关键词
  author?: string           // 作者
  homepage?: string         // 主页 URL
  documentation?: string    // 文档 URL

  // === 可选字段 ===
  category?: string         // 技能分类
  tags?: string[]           // 标签
  icon_url?: string         // 图标 URL
  license?: string          // 许���证
  repository?: string       // 代码仓库 URL

  // === 执行配置 ===
  entry?: string            // 入口文件路径
  tools?: SkillTool[]       // 工具配置
  config?: Record<string, unknown>  // 技能配置

  // === 兼容性 ===
  anthropic?: {             // Anthropic 协议兼容
    type: 'anthropic' | 'custom'
    skill_id: string
    version?: string
  }
  container?: {             // Container 协议兼容
    skills: Array<{
      type: 'anthropic' | 'custom'
      skill_id: string
      version?: string
    }>
  }
}
```

---

## 兼容矩阵

### 字段映射表

| Semibot 字段 | Anthropic 字段 | Codex 字段 | 必需 | 说明 |
|-------------|---------------|-----------|------|------|
| `skill_id` | `skill_id` | `skill_id` | ✅ | 技能标识符 |
| `name` | `name` | `name` | ✅ | 技能名称 |
| `version` | `version` | `version` | ✅ | 版本号 |
| `description` | `description` | `description` | ⚠️ | 技能描述（推荐） |
| `trigger_keywords` | `trigger_keywords` | `trigger_keywords` | ⚠️ | 触发关键词（推荐） |
| `author` | `author` | `author` | ❌ | 作者 |
| `homepage` | `homepage` | `homepage` | ❌ | 主页 URL |
| `documentation` | `documentation` | `documentation` | ❌ | 文档 URL |
| `category` | - | - | ❌ | 技能分类（平台扩展） |
| `tags` | - | - | ❌ | 标签（平台扩展） |
| `icon_url` | - | `assets/icon.png` | ❌ | 图标 URL |
| `entry` | - | `scripts/main.*` | ❌ | 入口文件 |
| `tools` | - | - | ❌ | 工具配置（平台扩展） |
| `config` | - | `scripts/config.yaml` | ❌ | 技能配置 |
| `anthropic` | `container.skills` | - | ❌ | Anthropic 兼容 |
| `container` | `container` | - | ❌ | Container 兼容 |

**图例**:
- ✅ 必需字段
- ⚠️ 推荐字段
- ❌ 可选字段

---

### 目录结构兼容

| 文件/目录 | Anthropic | Codex | Semibot | 说明 |
|----------|-----------|-------|---------|------|
| `SKILL.md` | ❌ | ✅ | ✅ | 技能说明文档（必需） |
| `manifest.json` | ✅ | ⚠️ | ✅ | 元数据清单（必需） |
| `scripts/` | ❌ | ✅ | ✅ | 可执行脚本（可选） |
| `references/` | ❌ | ✅ | ✅ | 参考文档（可选） |
| `assets/` | ❌ | ✅ | ✅ | 资源文件（可选） |

**Semibot 目录结构规范**:

```
{SKILLS_STORAGE_ROOT}/{skill_id}/{version}/
├── SKILL.md              # 必需：技能说明文档
├── manifest.json         # 必需：元数据清单
├── scripts/              # 可选：可执行脚本
│   ├── main.py
│   ├── utils.js
│   └── config.yaml
├── references/           # 可选：参考文档
│   ├── api-docs.md
│   └── examples.md
└── assets/               # 可选：资源文件
    ├── icon.png
    └��─ screenshot.png
```

---

## 协议转换

### 1. Anthropic → Semibot

**转换规则**:

```typescript
function convertAnthropicToSemibot(
  anthropicManifest: AnthropicSkillManifest
): SemibotSkillManifest {
  return {
    // 必需字段
    skill_id: anthropicManifest.skill_id,
    name: anthropicManifest.name,
    version: anthropicManifest.version,

    // 推荐字段
    description: anthropicManifest.description,
    trigger_keywords: anthropicManifest.trigger_keywords,
    author: anthropicManifest.author,
    homepage: anthropicManifest.homepage,
    documentation: anthropicManifest.documentation,

    // 兼容性字段
    anthropic: {
      type: 'anthropic',
      skill_id: anthropicManifest.skill_id,
      version: anthropicManifest.version,
    },
    container: anthropicManifest.container,

    // 平台扩展字段
    category: inferCategory(anthropicManifest),
    tags: inferTags(anthropicManifest),
  }
}
```

**示例**:

```typescript
// Anthropic Manifest
const anthropicManifest = {
  skill_id: 'text-editor',
  version: '1.0.0',
  name: 'Text Editor',
  description: 'Edit and manipulate text content',
  trigger_keywords: ['edit', 'text', 'modify'],
  container: {
    skills: [
      {
        type: 'anthropic',
        skill_id: 'text-editor',
        version: '1.0.0',
      },
    ],
  },
}

// 转换为 Semibot Manifest
const semibotManifest = convertAnthropicToSemibot(anthropicManifest)
// {
//   skill_id: 'text-editor',
//   version: '1.0.0',
//   name: 'Text Editor',
//   description: 'Edit and manipulate text content',
//   trigger_keywords: ['edit', 'text', 'modify'],
//   anthropic: {
//     type: 'anthropic',
//     skill_id: 'text-editor',
//     version: '1.0.0',
//   },
//   container: { ... },
//   category: 'productivity',
//   tags: ['text', 'editor'],
// }
```

---

### 2. Codex → Semibot

**转换规则**:

```typescript
async function convertCodexToSemibot(
  codexPackagePath: string
): Promise<SemibotSkillManifest> {
  // 1. 读取 SKILL.md
  const skillMd = await fs.readFile(
    path.join(codexPackagePath, 'SKILL.md'),
    'utf-8'
  )

  // 2. 解析 Frontmatter
  const { data: frontmatter, content } = matter(skillMd)

  // 3. 读取 manifest.json（如果存在）
  let manifestJson = {}
  const manifestPath = path.join(codexPackagePath, 'manifest.json')
  if (await fs.pathExists(manifestPath)) {
    manifestJson = await fs.readJson(manifestPath)
  }

  // 4. 合并数据（manifest.json 优先）
  return {
    // 必需字段
    skill_id: manifestJson.skill_id || frontmatter.skill_id,
    name: manifestJson.name || frontmatter.name,
    version: manifestJson.version || frontmatter.version,

    // 推荐字段
    description: manifestJson.description || frontmatter.description,
    trigger_keywords: manifestJson.trigger_keywords || frontmatter.trigger_keywords,
    author: manifestJson.author || frontmatter.author,
    homepage: manifestJson.homepage || frontmatter.homepage,
    documentation: manifestJson.documentation || frontmatter.documentation,

    // 推断入口文件
    entry: await inferEntryFile(codexPackagePath),

    // 平台扩展字段
    category: manifestJson.category || inferCategory(frontmatter),
    tags: manifestJson.tags || inferTags(frontmatter),
  }
}

/**
 * 推断入口文件
 */
async function inferEntryFile(packagePath: string): Promise<string | undefined> {
  const scriptsDir = path.join(packagePath, 'scripts')
  if (!(await fs.pathExists(scriptsDir))) {
    return undefined
  }

  // 按优先级查找入口文件
  const candidates = [
    'main.py',
    'main.js',
    'main.ts',
    'index.py',
    'index.js',
    'index.ts',
  ]

  for (const candidate of candidates) {
    const filePath = path.join(scriptsDir, candidate)
    if (await fs.pathExists(filePath)) {
      return `scripts/${candidate}`
    }
  }

  return undefined
}
```

---

### 3. Semibot → Anthropic

**转换规则**:

```typescript
function convertSemibotToAnthropic(
  semibotManifest: SemibotSkillManifest
): AnthropicSkillManifest {
  return {
    skill_id: semibotManifest.skill_id,
    version: semibotManifest.version,
    name: semibotManifest.name,
    description: semibotManifest.description,
    trigger_keywords: semibotManifest.trigger_keywords,
    author: semibotManifest.author,
    homepage: semibotManifest.homepage,
    documentation: semibotManifest.documentation,
    container: semibotManifest.container || {
      skills: [
        {
          type: semibotManifest.anthropic?.type || 'custom',
          skill_id: semibotManifest.skill_id,
          version: semibotManifest.version,
        },
      ],
    },
  }
}
```

---

## 自动化校验

### 1. Manifest 校验脚本

```typescript
import { z } from 'zod'

/**
 * Semibot Skill Manifest Schema
 */
const SemibotSkillManifestSchema = z.object({
  // 必需字段
  skill_id: z.string().min(1).max(120).regex(/^[a-zA-Z0-9._:/-]+$/),
  name: z.string().min(1).max(100),
  version: z.string().min(1).max(50).regex(/^\d+\.\d+\.\d+(-[a-zA-Z0-9.]+)?$/),

  // 推荐字段
  description: z.string().max(1000).optional(),
  trigger_keywords: z.array(z.string().max(50)).max(20).optional(),
  author: z.string().max(100).optional(),
  homepage: z.string().url().optional(),
  documentation: z.string().url().optional(),

  // 可选字段
  category: z.string().max(50).optional(),
  tags: z.array(z.string().max(30)).max(10).optional(),
  icon_url: z.string().url().optional(),
  license: z.string().max(50).optional(),
  repository: z.string().url().optional(),

  // 执行配置
  entry: z.string().max(200).optional(),
  tools: z.array(z.object({
    name: z.string(),
    type: z.enum(['function', 'mcp']),
    config: z.record(z.unknown()).optional(),
  })).optional(),
  config: z.record(z.unknown()).optional(),

  // 兼容性
  anthropic: z.object({
    type: z.enum(['anthropic', 'custom']),
    skill_id: z.string(),
    version: z.string().optional(),
  }).optional(),
  container: z.object({
    skills: z.array(z.object({
      type: z.enum(['anthropic', 'custom']),
      skill_id: z.string(),
      version: z.string().optional(),
    })),
  }).optional(),
})

/**
 * 校验 Manifest
 */
export function validateManifest(manifest: unknown): SemibotSkillManifest {
  try {
    return SemibotSkillManifestSchema.parse(manifest)
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new Error(`Manifest validation failed: ${error.message}`)
    }
    throw error
  }
}
```

---

### 2. 目录结构校验脚本

```typescript
import * as fs from 'fs-extra'
import * as path from 'path'

/**
 * 目录结构校验结果
 */
interface ValidationResult {
  valid: boolean
  errors: string[]
  warnings: string[]
  details: {
    hasSkillMd: boolean
    hasManifestJson: boolean
    hasScripts: boolean
    hasReferences: boolean
    hasAssets: boolean
    entryFile?: string
  }
}

/**
 * 校验 Skill 包目录结构
 */
export async function validatePackageStructure(
  packagePath: string
): Promise<ValidationResult> {
  const errors: string[] = []
  const warnings: string[] = []
  const details = {
    hasSkillMd: false,
    hasManifestJson: false,
    hasScripts: false,
    hasReferences: false,
    hasAssets: false,
    entryFile: undefined as string | undefined,
  }

  // 1. 检查 SKILL.md（必需）
  const skillMdPath = path.join(packagePath, 'SKILL.md')
  if (await fs.pathExists(skillMdPath)) {
    details.hasSkillMd = true
  } else {
    errors.push('Missing required file: SKILL.md')
  }

  // 2. 检查 manifest.json（推荐）
  const manifestPath = path.join(packagePath, 'manifest.json')
  if (await fs.pathExists(manifestPath)) {
    details.hasManifestJson = true

    // 校验 manifest 内容
    try {
      const manifest = await fs.readJson(manifestPath)
      validateManifest(manifest)
    } catch (error) {
      errors.push(`Invalid manifest.json: ${error.message}`)
    }
  } else {
    warnings.push('Missing recommended file: manifest.json')
  }

  // 3. 检查 scripts/ 目录（可选）
  const scriptsDir = path.join(packagePath, 'scripts')
  if (await fs.pathExists(scriptsDir)) {
    details.hasScripts = true

    // 推断入口文件
    details.entryFile = await inferEntryFile(packagePath)
    if (!details.entryFile) {
      warnings.push('No entry file found in scripts/ directory')
    }
  }

  // 4. 检查 references/ 目录（可选）
  const referencesDir = path.join(packagePath, 'references')
  if (await fs.pathExists(referencesDir)) {
    details.hasReferences = true
  }

  // 5. 检查 assets/ 目录（可选）
  const assetsDir = path.join(packagePath, 'assets')
  if (await fs.pathExists(assetsDir)) {
    details.hasAssets = true
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    details,
  }
}
```

---

### 3. 兼容性检查脚本

```typescript
/**
 * 检查 Skill 与协议的兼容性
 */
export function checkProtocolCompatibility(
  manifest: SemibotSkillManifest
): {
  anthropic: boolean
  codex: boolean
  semibot: boolean
  issues: string[]
} {
  const issues: string[] = []

  // 检查 Anthropic 兼容性
  const anthropicCompatible = !!(
    manifest.skill_id &&
    manifest.name &&
    manifest.version &&
    (manifest.anthropic || manifest.container)
  )

  if (!anthropicCompatible) {
    issues.push('Missing Anthropic compatibility fields (anthropic or container)')
  }

  // 检查 Codex 兼容性
  const codexCompatible = !!(
    manifest.skill_id &&
    manifest.name &&
    manifest.version
  )

  if (!codexCompatible) {
    issues.push('Missing Codex compatibility fields')
  }

  // 检查 Semibot 兼容性
  const semibotCompatible = !!(
    manifest.skill_id &&
    manifest.name &&
    manifest.version
  )

  if (!semibotCompatible) {
    issues.push('Missing Semibot required fields')
  }

  return {
    anthropic: anthropicCompatible,
    codex: codexCompatible,
    semibot: semibotCompatible,
    issues,
  }
}
```

---

## 使用示例

### 安装 Anthropic Skill

```typescript
// 1. 从 Catalog 获取 Skill 信息
const catalog = await fetchAnthropicCatalog()
const skillInfo = catalog.skills.find(s => s.skill_id === 'text-editor')

// 2. 获取 Manifest
const manifest = await fetchManifest(skillInfo.manifest_url)

// 3. 转换为 Semibot 格式
const semibotManifest = convertAnthropicToSemibot(manifest)

// 4. 校验 Manifest
validateManifest(semibotManifest)

// 5. 安装 Skill
await installSkillPackage({
  skillDefinitionId: definitionId,
  version: semibotManifest.version,
  sourceType: 'anthropic',
  manifestUrl: skillInfo.manifest_url,
  ...semibotManifest,
})
```

### 安装 Codex Skill

```typescript
// 1. 下载 Skill 包
const packagePath = await downloadPackage(sourceUrl)

// 2. 校验目录结构
const validation = await validatePackageStructure(packagePath)
if (!validation.valid) {
  throw new Error(`Invalid package structure: ${validation.errors.join(', ')}`)
}

// 3. 转换为 Semibot 格式
const semibotManifest = await convertCodexToSemibot(packagePath)

// 4. 校验 Manifest
validateManifest(semibotManifest)

// 5. 安装 Skill
await installSkillPackage({
  skillDefinitionId: definitionId,
  version: semibotManifest.version,
  sourceType: 'git',
  sourceUrl: sourceUrl,
  packagePath: packagePath,
  ...semibotManifest,
})
```

---

## 总结

### 兼容性矩阵

| 特性 | Anthropic | Codex | Semibot |
|------|-----------|-------|---------|
| Manifest JSON | ✅ | ⚠️ | ✅ |
| SKILL.md | ❌ | ✅ | ✅ |
| 目录结构 | ❌ | ✅ | ✅ |
| Container 协议 | ✅ | ❌ | ✅ |
| 版本管理 | ⚠️ | ❌ | ✅ |
| 来源追溯 | ❌ | ❌ | ✅ |
| 校验值 | ❌ | ❌ | ✅ |
| 安装日志 | ❌ | ❌ | ✅ |

### 最小兼容字段集

**必需字段**:
- `skill_id`
- `name`
- `version`

**推荐字段**:
- `description`
- `trigger_keywords`

**可选字段**:
- `author`
- `homepage`
- `documentation`
- `category`
- `tags`
- `icon_url`
- `entry`
- `tools`
- `config`

### 自动化校验

提供三个校验脚本：
1. **Manifest 校验**：`validateManifest()`
2. **目录结构校验**：`validatePackageStructure()`
3. **兼容性检查**：`checkProtocolCompatibility()`

所有校验脚本可集成到 CI/CD 流程中，确保安装的 Skills 符合规范。
