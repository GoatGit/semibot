# PRD: Skill 系统重构 — 全面切换到 SKILL.md 模式

## 概述

| 字段 | 值 |
|------|-----|
| **功能名称** | Skill 系统重构 |
| **版本** | 3.0 |
| **优先级** | P0 |
| **关联任务** | [TASK](../TASKS/skill-system-overhaul.md) |
| **创建时间** | 2026-02-12 |
| **前置 PRD** | [skills-management-and-usage-spec.md](./skills-management-and-usage-spec.md) |

---

## 1. 问题陈述

### 1.1 生态脱节

通过分析 18 个真实 Skill 包（来自 Anthropic 官方 Skills 仓库、ClawHub 等），发现当前系统与生态严重不匹配：

| 维度 | 当前系统要求 | 真实生态 |
|------|------------|---------|
| 元数据文件 | `manifest.json`（必需，Zod 严格校验） | 无 manifest.json，仅 SKILL.md frontmatter |
| 必需字段 | skill_id, name, version, tools[].type | 仅 name + description |
| Skill 本质 | function calling 工具定义 | LLM 操作手册（prompt 模板） |
| scripts/ | 未被加载或执行 | LLM 通过 bash 调用的辅助脚本 |
| 上下文加载 | 全量加载所有 skill 定义 | 索引 + 按需读取（懒加载） |

### 1.2 真实 Skill 包结构

以 `pdf` skill 为例（来自 Anthropic 官方）：
```
pdf/
├── SKILL.md              ← frontmatter 仅有 name + description
├── REFERENCE.md          ← 高级用法文档
├── FORMS.md              ← 表单处理指南
├── scripts/              ← 8 个 Python CLI 脚本
│   ├── check_fillable_fields.py
│   ├── fill_pdf_form_with_annotations.py
│   ├── extract_form_field_info.py
│   └── ...
└── LICENSE.txt
```

SKILL.md frontmatter：
```yaml
---
name: pdf
description: Use this skill whenever the user wants to do anything with PDF files...
license: Proprietary. LICENSE.txt has complete terms
---
```

### 1.3 核心问题

1. **安装失败**：纯 SKILL.md 包因缺少 manifest.json 无法通过校验
2. **上下文浪费**：每条消息加载所有 skill 完整定义，10 个 skill 可消耗数千 token
3. **执行断裂**：用户安装的 skill 包从未被 Runtime 加载，scripts/ 无法执行
4. **模型锁定**：container.skills 仅 Anthropic 可用，其他 LLM provider 无法使用 skill，本次重构一并移除

### 1.4 决策：废弃 manifest.json

manifest.json 是早期自定义格式，生态中无任何真实 Skill 包使用此格式。继续维护双格式兼容会增加代码复杂度且无实际价值。**本次重构彻底移除 manifest.json 支持，统一为 SKILL.md 模式。**

---

## 2. 目标与非目标

### 目标

| ID | 目标 | 衡量标准 |
|----|------|---------|
| G1 | 统一 SKILL.md 格式 | 所有 skill 均使用 SKILL.md 格式，移除 manifest.json 校验和解析逻辑 |
| G2 | 支持纯 SKILL.md 格式安装 | 18 个真实 skill 包均可成功安装 |
| G3 | 实现懒加载 | 系统提示词仅含索引（~50 token/skill），完整内容按需读取 |
| G4 | scripts/ 可通过 bash 执行 | LLM 能调用 `python scripts/xxx.py` 并获取结果 |
| G5 | 多 LLM 支持 | 懒加载模式不依赖特定 LLM provider |

### 非目标

- NG1: 不重写 Python Runtime SkillRegistry 架构
- NG2: 不实现 Skill 市场/注册中心
- NG3: 不实现 Skill 版本管理（保持覆盖式安装）
- NG4: 不修改 MCP 工具加载机制
- NG5: 不保留 manifest.json 向后兼容

---

## 3. 数据模型变更

### 3.1 skill_definitions 表 — 新增字段

```sql
ALTER TABLE skill_definitions
  ADD COLUMN skill_md_content TEXT,
  ADD COLUMN file_inventory JSONB NOT NULL DEFAULT '{}';
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `skill_md_content` | `TEXT` | SKILL.md 原始内容（用于预览和索引） |
| `file_inventory` | `JSONB` | 文件清单 |

`file_inventory` 结构：
```json
{
  "hasSkillMd": true,
  "hasScripts": true,
  "hasReferences": true,
  "scriptFiles": ["scripts/check_fillable_fields.py", "scripts/recalc.py"],
  "referenceFiles": ["REFERENCE.md", "FORMS.md"],
  "templateFiles": [],
  "totalFiles": 12,
  "totalSizeBytes": 45678
}
```

### 3.2 skill_packages 表 — 新增字段

```sql
ALTER TABLE skill_packages
  ADD COLUMN skill_md_hash VARCHAR(64),
  ADD COLUMN file_inventory JSONB NOT NULL DEFAULT '{}';
```

### 3.3 skills 表 — 新增字段

```sql
ALTER TABLE skills
  ADD COLUMN skill_md_content TEXT,
  ADD COLUMN file_inventory JSONB NOT NULL DEFAULT '{}',
  ADD COLUMN package_path TEXT;
```

### 3.4 清理 legacy 字段

移除 manifest.json ��关的旧字段和逻辑：
- 删除 `manifest` / `manifest_json` 相关列（如存在）
- 删除 `tools` JSONB 列中的 manifest 工具定义（如存在）
- 删除 `container_skills` 相关字段（如存在）

---

## 4. 安装流程变更

### 4.1 统一流程（SKILL.md 格式）

```
上传包 → 解压 → 校验 SKILL.md 存在 → 解析 frontmatter → 安装
```

manifest.json 如果存在将被忽略，不再作为元数据来源。

### 4.2 安装步骤

```
1. gray-matter 解析 SKILL.md frontmatter
   → 提取 name（必需）、description（必需）
   → 可选：license, author, metadata

2. 自动生成 skill_id
   → 优先用 frontmatter.name（slug 化：小写 + 连字符）
   → 回退用目录名

3. 自动生成 version
   → 时间戳格式：YYYYMMDD-HHmmss（已有此模式）

4. 扫描目录结构 → 生成 file_inventory
   → 检测 scripts/、references/、templates/ 等
   → 列出所有文件路径

5. 读取 SKILL.md 完整内容 → 存入 skill_md_content

6. 复制到 SKILL_STORAGE_PATH/{skillId}/current/

7. 写入 DB（skill_definitions + skill_packages）
```

### 4.3 校验规则变更

**修改文件**: `apps/api/src/utils/skill-validator.ts`

| 规则 | Before | After |
|------|--------|-------|
| SKILL.md | 必需 | 必需（不变） |
| manifest.json | 缺少时报 error | 完全移除校验，忽略此文件 |
| skill_id | manifest 必需字段 | 从 frontmatter.name 自动生成 |
| version | manifest 必需字段 | 自动生成时间戳 |
| tools[] | manifest 可选字段 | 移除，不再需要 |
| frontmatter.name | 仅 warning | 必需，缺失报 error |
| frontmatter.description | 仅 warning | 必需，缺失报 error |

### 4.4 清理项

- 移除 `manifest.json` 的 Zod schema 定义
- 移除 `validateManifest()` 函数
- 移除 manifest 相关的错误码和错误消息
- 移除 `container.skills` 直通逻辑（chat.service.ts 中将 skill 作为 Anthropic container 传递的代码）

---

## 5. Skill 加载机制（核心变更）

### 5.1 懒加载三阶段

**阶段 1：索引注入（每次消息，成本低）**

在 system prompt 末尾追加：
```
<available_skills>
  <skill name="pdf" path="/var/lib/semibot/skills/pdf/current/">
    处理 PDF 文件（读取、合并、拆分、表单填写等）
    文件: SKILL.md, REFERENCE.md, FORMS.md, scripts/(8个脚本)
  </skill>
  <skill name="xlsx" path="/var/lib/semibot/skills/xlsx/current/">
    处理 Excel 文件（创建、编辑、公式、图表等）
    文件: SKILL.md, scripts/recalc.py
  </skill>
</available_skills>

当任务匹配某个技能时，先用 read_skill_file 工具读取对应的 SKILL.md 获取完整指南。
如需执行技能中的脚本，使用 bash 工具运行。脚本位于技能目录的 scripts/ 下。
```

每个 skill 约 50-100 token，20 个 skill 约 1000-2000 token。

**阶段 2：按需读取（LLM 决定，仅在需要时）**

LLM 判断用户请求匹配某个 skill → 调用 `read_skill_file` 工具：
```json
{
  "name": "read_skill_file",
  "arguments": {
    "skill_name": "pdf",
    "file_path": "SKILL.md"
  }
}
```

返回 SKILL.md 完整内容（500-5000 token），LLM 按指令行动。

如需更多信息，LLM 可继续读取：
```json
{ "skill_name": "pdf", "file_path": "FORMS.md" }
{ "skill_name": "pdf", "file_path": "REFERENCE.md" }
```

**阶段 3：执行（LLM 按 SKILL.md 指令操作）**

LLM 读完指令后，通过已有工具执行：
- 写 Python 代码 → `code_run` 工具
- 调用 scripts/ → `bash` 工具：`python /var/lib/semibot/skills/pdf/current/scripts/check_fillable_fields.py input.pdf`
- 读写文件 → `file_read` / `file_write` 工具

### 5.2 read_skill_file 工具定义

```typescript
{
  type: 'function',
  function: {
    name: 'read_skill_file',
    description: '读取已安装技能的文件内容。用于获取技能的完整指南、参考文档或查看脚本。',
    parameters: {
      type: 'object',
      properties: {
        skill_name: {
          type: 'string',
          description: '技能名称（与 available_skills 中的 name 对应）'
        },
        file_path: {
          type: 'string',
          description: '要读取的文件路径（相对于技能目录），如 SKILL.md、REFERENCE.md、scripts/main.py'
        }
      },
      required: ['skill_name', 'file_path']
    }
  }
}
```

### 5.3 与现有机制的关系

| 机制 | 处理方式 |
|------|---------|
| 所有 skill | 统一走懒加载（索引 + read_skill_file） |
| MCP 工具 | 保持原逻辑（全量 schema 加载） |
| 内置工具（CodeExecutor, WebSearch） | 保持原逻辑（Registry 注册） |

### 5.4 chat.service.ts 改动要点

```typescript
// handleChatDirect() 改动

// 1. 加载 skill 索引（轻量）
const boundSkills = await skillService.getActiveSkillsByIds(orgId, agent.skills ?? [])

// 2. 所有 skill 统一走懒加载（不再区分 legacy/skillmd）
const skillIndex = buildSkillIndex(boundSkills)
const systemPrompt = agent.systemPrompt + '\n\n' + skillIndex

// 3. 注册 read_skill_file 工具
const skillTools = boundSkills.length > 0 ? [READ_SKILL_FILE_TOOL_DEF] : []
const allTools = [...mcpTools, ...skillTools]

// 4. 处理 read_skill_file 工具调用
// 在 tool_call handler 中：
if (toolCall.name === 'read_skill_file') {
  const content = await readSkillFile(skillCall.skill_name, skillCall.file_path)
  // 返回文件内容作为 tool result
}

// 5. 移除 container.skills 直通逻辑（不再将 skill 作为 Anthropic container 传递）
```

---

## 6. 执行机制

### 6.1 scripts/ 执行路径

LLM 读取 SKILL.md 后，按指令调用 scripts/：

```
LLM 决定调用 → bash 工具 →
  命令: python /var/lib/semibot/skills/pdf/current/scripts/check_fillable_fields.py input.pdf
  → SandboxManager.execute_shell() （如果 sandbox 可用）
  → 或直接执行（如果 sandbox 不可用）
```

### 6.2 安全约束

- scripts/ 路径必须在 `SKILL_STORAGE_PATH` 下（防止路径穿越）
- read_skill_file 只能读取已安装 skill 目录内的文件
- bash 执行走 SandboxManager（已有 Docker 沙箱）
- PolicyEngine 已有命令白名单/黑名单机制

---

## 7. API 变更

### 7.1 新增/修改端点

| 方法 | 路径 | 变更 |
|------|------|------|
| `POST /:id/upload-install` | 修改 | 仅支持 SKILL.md 包，移除 manifest.json 校验 |
| `GET /:id/preview` | 新增 | 返回 SKILL.md 内容和文件清单 |
| `GET /:id/files/:path` | 新增 | 读取 skill 包内指定文件（用于前端预览） |

### 7.2 响应格式变更

SkillDefinition 响应新增字段：
```json
{
  "id": "...",
  "skillId": "pdf",
  "name": "pdf",
  "description": "Use this skill whenever...",
  "fileInventory": {
    "hasSkillMd": true,
    "hasScripts": true,
    "scriptFiles": ["scripts/check_fillable_fields.py", "..."],
    "referenceFiles": ["REFERENCE.md", "FORMS.md"]
  },
  "currentVersion": "20260212-143000",
  "isActive": true
}
```

---

## 8. 前端变更

### 8.1 安装流程简化

- 上传 .zip/.tar.gz 后，解析 SKILL.md frontmatter
- 自动填充 name、description
- 移除所有 manifest.json 相关的 UI 和错误提示
- 显示文件清单预览（scripts/、references/ 等）

### 8.2 Skill 详情页

- 渲染 SKILL.md 内容（Markdown 预览）
- 显示文件树（scripts/、references/ 等）

### 8.3 Agent 配置页

- Skill 选择列表显示简短描述（来自 frontmatter.description）

---

## 9. 迁移计划

### 9.1 数据库迁移

```sql
-- 新增字段
ALTER TABLE skill_definitions
  ADD COLUMN IF NOT EXISTS skill_md_content TEXT,
  ADD COLUMN IF NOT EXISTS file_inventory JSONB NOT NULL DEFAULT '{}';

ALTER TABLE skill_packages
  ADD COLUMN IF NOT EXISTS skill_md_hash VARCHAR(64),
  ADD COLUMN IF NOT EXISTS file_inventory JSONB NOT NULL DEFAULT '{}';

ALTER TABLE skills
  ADD COLUMN IF NOT EXISTS skill_md_content TEXT,
  ADD COLUMN IF NOT EXISTS file_inventory JSONB NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS package_path TEXT;

-- 清理 legacy 字段（如存在）
-- ALTER TABLE skill_definitions DROP COLUMN IF EXISTS skill_format;
-- ALTER TABLE skills DROP COLUMN IF EXISTS skill_format;
```

### 9.2 已有数据处理

- 已安装的 legacy 格式 skill 需要重新上传安装（使用 SKILL.md 格式包）
- 或编写迁移脚本：从磁盘上已有的 SKILL.md 回填 `skill_md_content` 和 `file_inventory`
- 移除代码中所有 `skill_format` 判断分支、`container.skills` 直通逻辑和 manifest 相关代码

### 9.3 代码清理清单

| 清理项 | 文件 |
|--------|------|
| 移除 manifest.json Zod schema | `skill-validator.ts` |
| 移除 `validateManifest()` | `skill-validator.ts` |
| 移除 `skill_format` 字段和分支逻辑 | 所有 repository、service |
| 移除 `container.skills` 直通逻辑 | `chat.service.ts` |
| 移除 manifest 相关错误码 | `constants/errorCodes.ts` |
| 移除前端 manifest 相关 UI | `skills/page.tsx` |
