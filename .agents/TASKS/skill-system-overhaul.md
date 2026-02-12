# TASK: Skill 系统重构实施计划

**ID:** skill-system-overhaul
**PRD:** [skill-system-overhaul.md](../PRDS/skill-system-overhaul.md)
**Status:** Backlog
**Priority:** P0
**Created:** 2026-02-12

---

## Phase 1: 数据模型 & 校验（基础层）

### Task 1.1: 数据库迁移脚本
- **描述**: 新增 skill_md_content、file_inventory、package_path 字段，清理 legacy 字段
- **文件**:
  - 新建 `docs/sql/skill-system-overhaul.sql`
- **SQL**:
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
- **验收**: SQL 执行成功，现有数据不受影响
- **复杂度**: S
- **依赖**: 无

### Task 1.2: 校验器全面切换到 SKILL.md
- **描述**: 移除 manifest.json 校验逻辑，统一走 SKILL.md frontmatter 解析
- **文件**:
  - `apps/api/src/utils/skill-validator.ts`
- **改动要点**:
  - 移除 `manifestSchema`（Zod schema）定义
  - 移除 `validateManifest()` 函数
  - 移除 `validatePackageStructure()` 中 manifest.json 相关检查
  - 新增 `parseSkillMdFrontmatter(packagePath)`: 用 gray-matter 解析 SKILL.md，提取 name + description（必需）
  - 新增 `scanFileInventory(packagePath)`: 扫描目录生成 file_inventory JSON
  - 新增 `generateSkillId(name, dirName)`: 从 name slug 化生成 skill_id
  - `validateSkillPackage()`: 返回结果新增 `frontmatter`、`fileInventory` 字段
  - 移除所有 manifest 相关的错误码和消息
- **验收**:
  - 纯 SKILL.md 包（如 user-stories/skills/pdf）校验通过，valid=true
  - frontmatter 缺少 name 或 description 时报 error
  - manifest.json 存在时被忽略，不影响校验结果
- **复杂度**: M
- **依赖**: 无

### Task 1.3: Repository 层适配
- **描述**: 更新 Repository 的 create/update/find 方法，移除 skill_format 字段，支持新字段
- **文件**:
  - `apps/api/src/repositories/skill-definition.repository.ts`
  - `apps/api/src/repositories/skill-package.repository.ts`
  - `apps/api/src/repositories/skill.repository.ts`
- **改动要点**:
  - create/upsert SQL 新增 skill_md_content、file_inventory 字段
  - 移除所有 skill_format 相关的字段读写和条件判断
  - find 方法返回新字段
  - 使用 `sql.json()` 写入 file_inventory（遵循 JSONB 规范）
- **验收**: 新字段可正常读写，无 skill_format 残留
- **复杂度**: M
- **依赖**: Task 1.1

---

## Phase 2: 安装流程改造

### Task 2.1: 安装服务统一 SKILL.md 流程
- **描述**: installSkillPackage 移除格式检测分支，统一走 SKILL.md 流程
- **文件**:
  - `apps/api/src/services/skill-install.service.ts`
- **改动要点**:
  - 移除 skill_format 检测和分支逻辑
  - 统一从 SKILL.md frontmatter 提取 name/description
  - 自动生成 skill_id（slug 化）和 version（时间戳）
  - 读取 SKILL.md 内容存入 skill_md_content
  - 存入 file_inventory
  - 移除 manifest.json 解析逻辑
- **验收**:
  - `user-stories/skills/pdf` 打包后可成功安装
  - `user-stories/skills/xlsx` 打包后可成功安装
  - DB 中 skill_md_content 有内容，file_inventory 正确
  - 不存在任何 skill_format 字段写入
- **复杂度**: L
- **依赖**: Task 1.2, Task 1.3

### Task 2.2: 上传服务适配
- **描述**: uploadAndInstall 移除 manifest.json 依赖，统一 SKILL.md 流程
- **文件**:
  - `apps/api/src/services/skill-upload.service.ts`
- **改动要点**:
  - 解压后直接校验 SKILL.md 存在性（不再检测 manifest.json）
  - 从 frontmatter 自动创建 skill_definition（如果不存在）
  - 支持"一键上传安装"：上传包 → 自动创建 definition → 安装
  - 移除所有 manifest 相关的解析和校验代码
- **验收**: 直接上传 pdf.zip 可一步完成创建 + 安装
- **复杂度**: M
- **依赖**: Task 2.1

### Task 2.3: 路由层适配
- **描述**: 路由层移除 manifest 相关逻辑，新增预览端点
- **文件**:
  - `apps/api/src/routes/v1/skill-definitions.ts`
- **改动要点**:
  - `POST /:id/upload-install`: 移除 manifest.json 校验，仅要求 SKILL.md
  - 新增 `POST /upload-auto`: 上传包自动创建 definition + 安装（可选）
  - 新增 `GET /:id/preview`: 返回 SKILL.md 内容和文件清单
  - 新增 `GET /:id/files/*path`: 读取 skill 包内文件（安全校验路径）
- **验收**: 新端点可正常调用，路径穿越被拦截
- **复杂度**: M
- **依赖**: Task 2.1

---

## Phase 3: 懒加载实现（核心）

### Task 3.1: Skill 索引生成器
- **���述**: 新建工具函数，从 DB 中的 skill 列表生成轻量 XML 索引
- **文件**:
  - 新建 `apps/api/src/utils/skill-prompt-builder.ts`
- **功能**:
  - `buildSkillIndex(skills: Skill[]): string` — 生成 `<available_skills>` XML 块
  - 每个 skill 包含：name、description（截断到 200 字符）、path、文件列表摘要
  - 末尾追加使用说明（何时读取 SKILL.md、如何调用 scripts/）
- **验收**: 10 个 skill 生成的索引 < 2000 token
- **复杂度**: S
- **依赖**: 无

### Task 3.2: read_skill_file 工具实现
- **描述**: 实现 LLM 可调用的 read_skill_file 工具
- **文件**:
  - 新建 `apps/api/src/services/skill-file.service.ts`
- **功能**:
  - `readSkillFile(skillName: string, filePath: string, orgId: string): Promise<string>`
  - 安全校验：filePath 不能包含 `..`，必须在 skill 目录内
  - 文件大小限制（防止超大文件撑爆上下文）
  - 返回文件内容（文本文件）或错误信息
- **工具定义**:
  ```typescript
  const READ_SKILL_FILE_TOOL: ToolDefinition = {
    type: 'function',
    function: {
      name: 'read_skill_file',
      description: '读取已安装技能的文件内容（SKILL.md、参考文档、脚本等）',
      parameters: {
        type: 'object',
        properties: {
          skill_name: { type: 'string', description: '技能名称' },
          file_path: { type: 'string', description: '文件路径（相对于技能目录）' }
        },
        required: ['skill_name', 'file_path']
      }
    }
  }
  ```
- **验收**: 可读取已安装 skill 的任意文本文件，路径穿越被拦截
- **复杂度**: M
- **依赖**: 无

### Task 3.3: chat.service.ts 集成懒加载
- **描述**: 修改 handleChatDirect，统一走懒加载，移除 container.skills 直通逻辑
- **文件**:
  - `apps/api/src/services/chat.service.ts`
- **改动要点**:
  - 加载 boundSkills 后，所有 skill 统一走懒加载（不再区分 legacy/skillmd）
  - 调用 `buildSkillIndex()` 追加到 system prompt
  - 注册 `read_skill_file` 工具到 toolDefinitions
  - 在 tool_call handler 中处理 `read_skill_file` 调用
  - 在 tool_call handler 中处理 bash 调用时，允许访问 skill scripts/ 路径
  - **移除 container.skills 直通逻辑**（不再将 skill 作为 Anthropic container 传递）
  - 移除 legacySkills/skillmdSkills 分离逻辑
- **验收**:
  - 所有绑定 skill 的 agent，system prompt 包含 `<available_skills>` 索引
  - LLM 可调用 read_skill_file 读取 SKILL.md
  - LLM 可通过 bash 调用 scripts/
  - 无 container.skills 和 manifest 残留代码
- **复杂度**: L
- **依赖**: Task 3.1, Task 3.2

### Task 3.4: Runtime 模式适配（可选）
- **描述**: 如果使用 Python Runtime 模式，也需要支持懒加载
- **文件**:
  - `apps/api/src/adapters/runtime.adapter.ts`
  - `runtime/src/orchestrator/nodes.py`（可选）
- **改动要点**:
  - RuntimeInputState 新增 `available_skills_index` 字段（索引文本）
  - RuntimeInputState 新增 `skill_file_paths` 字段（skill 目录映射）
  - Python Runtime 的 planner 使用索引而非全量 schema
- **验收**: Runtime 模式下 skill 索引正确传递
- **复杂度**: M
- **依赖**: Task 3.3

---

## Phase 4: 前端更新

### Task 4.1: 安装 UI 简化
- **描述**: 移除所有 manifest.json 相关 UI，统一 SKILL.md 流程
- **文件**:
  - `apps/web/app/(dashboard)/skills/page.tsx`
  - `apps/web/hooks/useSkillDefinitions.ts`
- **改动要点**:
  - 上传后显示解析结果（name、description、文件清单）— 全部来自 SKILL.md frontmatter
  - 移除所有 manifest.json 相关的错误提示和 UI 元素
  - 移除 skill_format 标签显示（不再有格式区分）
  - 支持"一键上传安装"（自动创建 definition + 安装）
- **验收**: 上传 pdf.zip 后自动显示 name="pdf"、description、文件列表
- **复杂度**: M
- **依赖**: Task 2.3

### Task 4.2: Skill 详情预览
- **描述**: Skill 详情页显示 SKILL.md 渲染内容和文件树
- **文件**:
  - `apps/web/app/(dashboard)/skills/page.tsx`（或新建详情页）
- **改动要点**:
  - 调用 `GET /:id/preview` 获取 SKILL.md 内容
  - Markdown 渲染预览
  - 文件树展示（scripts/、references/ 等）
  - 移除 skill_format 标签（所有 skill 统一为 SKILL.md 格式）
- **验收**: 可��看已安装 skill 的 SKILL.md 内容和文件结构
- **复杂度**: M
- **依赖**: Task 2.3

---

## Phase 5: 清理 & 测试

### Task 5.0: Legacy 代码清理
- **描述**: 全面清理 manifest.json 和 skill_format 相关的残留代码
- **文件**: 所有涉及 skill 的文件
- **清理清单**:
  - `skill-validator.ts`: 移除 manifestSchema、validateManifest()
  - 所有 repository: 移除 skill_format 字段读写
  - `chat.service.ts`: 移除 container.skills 直通逻辑
  - `constants/errorCodes.ts`: 移除 manifest 相关错误码
  - `skills/page.tsx`: 移除 manifest 相关 UI
  - shared-types: 移除 skill_format 类型定义
- **验收**: 全局搜索 `manifest`、`skill_format`、`container.skills`、`legacy` 无残留
- **复杂度**: M
- **依赖**: Task 3.3, Task 4.1

### Task 5.1: 端到端安装测试
- **描述**: 用真实 skill 包测试完整安装流程
- **测试用例**:
  - 上传 `user-stories/skills/pdf` → 安装成功
  - 上传 `user-stories/skills/xlsx` → 安装成功，scripts/ 检测正确
  - 上传 `user-stories/skills/docx` → 安装成功，referenceFiles 正确
  - 上传 `user-stories/skills/mcp-builder` → 安装成功，reference/ 目录检测
  - 上传含 manifest.json 的旧包 → manifest.json 被忽略，从 SKILL.md 解析
- **验收**: 所有 18 个 user-stories/skills/ 下的包均可安装
- **复杂度**: M
- **依赖**: Task 2.2

### Task 5.2: 懒加载聊天测试
- **描述**: 验证 skill 索引注入和按需读取
- **测试用例**:
  - Agent 绑定 pdf skill → 聊天时 system prompt 包含索引
  - 用户说"帮我处理这个 PDF" → LLM 调用 read_skill_file 读取 SKILL.md
  - LLM 按 SKILL.md 指令调用 `python scripts/check_fillable_fields.py`
  - 用户说无关话题 → LLM 不读取任何 skill 文件（节省 token）
- **验收**: 懒加载正常工作，token 消耗显著低于全量加载
- **复杂度**: M
- **依赖**: Task 3.3

### Task 5.3: 构建验证
- **描述**: 全量构建通过
- **命令**: `pnpm --filter @semibot/shared build && pnpm --filter @semibot/api build && pnpm --filter @semibot/web build`
- **验收**: 无 TypeScript 错误
- **复杂度**: S
- **依赖**: 所有 Task

---

## 执行顺序总览

```
Phase 1 (基础层)          Phase 2 (安装)           Phase 3 (懒加载)        Phase 4 (前端)
┌─────────┐              ┌─────────┐              ┌─────────┐            ┌─────────┐
│ 1.1 DB  │──┐           │ 2.1 安装 │              │ 3.1 索引 │            │ 4.1 UI  │
└─────────┘  │           │  服务   │              │  生成器  │            │  简化   │
┌─────────┐  ├──────────▶│         │──┐           └────┬────┘            └────┬────┘
│ 1.2 校验 │──┤           └─────────┘  │           ┌────┴────┐            ┌────┴────┐
│  器     │  │           ┌─────────┐  ├──────────▶│ 3.3 chat│───────────▶│ 4.2 详情│
└─────────┘  │           │ 2.2 上传 │  │           │ 集成    │            │  预览   │
┌─────────┐  │           │  适配   │──┘           └────┬────┘            └─────────┘
│ 1.3 Repo│──┘           └─────────┘              ┌────┴────┐
│  层     │              ┌─────────┐              │ 3.4 运行 │
└─────────┘              │ 2.3 路由 │              │ 时适配   │
                         │  适配   │              └─────────┘
                         └─────────┘

                Phase 5 (清理 & 测试)
                ┌─────────────────┐
                │ 5.0 Legacy 清理  │
                │ 5.1-5.3 验证    │
                └─────────────────┘
```

## 关键文件清单

| 文件 | 操作 | Phase |
|------|------|-------|
| `docs/sql/skill-system-overhaul.sql` | 新建 | 1 |
| `apps/api/src/utils/skill-validator.ts` | 修改（移除 manifest 逻辑） | 1 |
| `apps/api/src/repositories/skill-definition.repository.ts` | 修改（移除 skill_format） | 1 |
| `apps/api/src/repositories/skill-package.repository.ts` | 修改 | 1 |
| `apps/api/src/repositories/skill.repository.ts` | 修改（移除 skill_format） | 1 |
| `apps/api/src/services/skill-install.service.ts` | 修改（移除格式分支） | 2 |
| `apps/api/src/services/skill-upload.service.ts` | 修改（移除 manifest 依赖） | 2 |
| `apps/api/src/routes/v1/skill-definitions.ts` | 修改 | 2 |
| `apps/api/src/utils/skill-prompt-builder.ts` | 新建 | 3 |
| `apps/api/src/services/skill-file.service.ts` | 新建 | 3 |
| `apps/api/src/services/chat.service.ts` | 修改（移除 container.skills 直通） | 3 |
| `apps/api/src/adapters/runtime.adapter.ts` | 修改 | 3 |
| `apps/web/app/(dashboard)/skills/page.tsx` | 修改（移除 manifest UI） | 4 |
| `apps/web/hooks/useSkillDefinitions.ts` | 修改 | 4 |

## 风险与缓解

| 风险 | 影响 | 缓解措施 |
|------|------|---------|
| 已有 legacy skill 数据不兼容 | 旧 skill 无法使用 | 提供迁移脚本回填 skill_md_content；或要求重新上传 |
| 懒加载增加 LLM 调用轮次 | 响应延迟增加 | read_skill_file 返回快（本地文件读取），可接受 |
| LLM 误判 skill 匹配 | 读取无关 skill 浪费 token | description 写得好可降低误判率，且成本可控 |
| scripts/ 执行安全风险 | 恶意脚本 | SandboxManager + PolicyEngine 已有防护 |
| 大 SKILL.md 撑爆上下文 | token 超限 | read_skill_file 加文件大小限制（如 50KB） |
