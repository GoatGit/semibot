# 进化机制（V2 重设计）

> 目标：基于 Semibot 当前能力与 `tmp/skills/self-improving-agent-1` 的经验，设计一套更优、更通用、可审计、可人工回退的持续进化系统。

## 1. 背景与问题

当前 Semibot 已具备基础进化能力（候选提取、验证、注册、索引、检索注入），但仍存在：

1. 事件化不完整：更多是 stage log，不是统一事件总线闭环。
2. 上线治理薄弱：缺少统一的人工版本治理、低样本门禁建议与效果归因。
3. 进化对象单一：主要是 `evolved_skills`，难覆盖规则模板、流程片段、工具最佳实践。
4. 上下文注入割裂：`system_prompt` 与“可进化的行为/流程/工具知识”没有统一注入层。

`self-improving-agent-1` 的可借鉴点：

1. 低成本采集：围绕失败、纠错、缺能力、复发问题快速记录 learning。
2. 结构化沉淀：统一模板（类别、优先级、状态、区域、元数据）。
3. 升格路径清晰：learning -> skill（可追溯）。

其不足（在 Semibot 企业场景下）：

1. 手工流程偏多，但缺少统一的人工决策与版本治理机制。
2. 缺少租户级策略、风险等级与审批编排。
3. 缺少线上效果反馈回路（adoption/success/regression）。

## 2. 设计目标

1. 从“技能提取器”升级为“能力进化平台（Capability Evolution Platform）”。
2. 统一进化对象：`hands / reflex / spine / guard / mind`。
3. 全链路可观测：每次进化可回答“为什么产生、为什么上线、上线后效果如何”。
4. 人工治理优先：进化与回退全部在进化中心由人工切换版本完成。

## 2.1 人工决策阈值规范（低样本友好）

统一建议函数（示意）：

```text
recommend_apply =
  recurrence_count >= min_recurrence
  AND extraction_confidence >= min_confidence
```

默认阈值（可租户覆盖）：

1. 复发次数阈值：`recurrence_count >= 2`（高风险类型 `>= 3`）。
2. 提取置信度：`extraction_confidence >= 0.70`（高风险类型 `>= 0.80`）。
3. 达到阈值仅表示“建议升级”，最终仍需人工点击切换版本。

说明：

1. 强制门禁仅有两项：`recurrence_count` 与 `extraction_confidence`。
2. 安全违规率、平均时延退化、单次调用成本退化仅为观察指标，不做自动阻断。

## 2.2 当前范围冻结（本阶段）

1. 工具类进化仅覆盖 `guard` 的上下文注入层（`<policy_tools>`）。
2. 工具配置层（`requiresApproval/riskLevel/timeout/allowlist` 等）不纳入进化流水线，只允许人工配置。
3. `spine` 作为预留能力类型保留在模型中，但本阶段不落地自动执行进化。
4. `spine` 的进化先走“planner 注入层”（规范+案例），不直接改执行协议。

## 3. 总体架构

### 3.1 三条主链路

1. `Learning Capture`（学习采集）
   - 从任务、工具执行、用户反馈、错误中抽取 `LearningRecord`。
2. `Capability Evolution`（能力进化）
   - Learning -> Candidate -> Validate -> Recommend -> Human Apply -> Observe。
3. `Context Injection`（上下文注入）
   - 通过 runtime 注入接口加载当前激活版本，不改业务主流程协议。

### 3.2 统一进化对象名称（代号）

1. `hands`
2. `reflex`
3. `spine`
4. `guard`
5. `mind`

### 3.3 统一进化对象

新增抽象：

```text
Capability
- type: hands | reflex | spine | guard | mind
- spec: 结构化定义（可执行/可注入）
- contract: 输入输出、前置条件、失败语义、幂等性
- checks: 阈值判定与安全闸规则
- policy: 风险等级、租户范围、人工干预开关
- version: active/deprecated
```

当前落地状态（V2 本阶段）：

1. `guard`: 已纳入进化范围（注入层）。
2. `hands`: 已有基础能力（沿用现有 evolved_skills/能力沉淀路径）。
3. `reflex`: 规划中。
4. `spine`: 规划中（先以 planner 提示增强落地，不修改计划 JSON 协议）。
5. `mind`: 规划中（由上下文注入体系承接）。

### 3.4 五大进化对象详细定义

以下定义用于统一“对象语义 + 注入位置 + 可编辑边界”，确保进化中心可独立管理。

#### 3.4.1 `hands`（执行手）

1. 核心作用：沉淀“可被执行器调用”的能力说明，解决重复任务执行路径复用。
2. 注入节点：planner 选型上下文 + executor 执行前能力检索上下文。
3. `spec` 最小结构：
   - `goal`: 能力目标
   - `inputs`: 入参定义（字段、类型、是否必填）
   - `steps`: 建议步骤（可自然语言）
   - `outputs`: 结果结构（必含 `status` 与 `result`）
4. `contract` 约束：
   - 前置条件：依赖的工具/权限/上下文是否存在
   - 失败语义：可重试/不可重试、失败错误码建议
   - 幂等性：同一输入是否允许重复执行
5. 边界：本阶段仅文本能力定义，不自动生成代码包与资源文件。
6. 典型示例：`pdf_summary_v1`、`weekly_report_compose_v2`。

#### 3.4.2 `reflex`（反射弧）

1. 核心作用：沉淀“规则模板”，将高频事件响应标准化为可复用规则草案。
2. 注入节点：规则创建助手（rule authoring）与规则推荐面板。
3. `spec` 最小结构：
   - `trigger_pattern`: 触发模式（事件类型/关键词/条件）
   - `condition_template`: 条件模板（可参数化）
   - `action_template`: 动作模板（可参数化）
4. `contract` 约束：
   - 输入：事件载荷字段映射
   - 输出：可直接提交的规则草案 JSON
   - 失败语义：字段缺失时给出补全建议，不直接发布
5. 边界：仅生成规则模板与建议，不自动启用线上规则。
6. 典型示例：`high_risk_tool_requires_approval`、`idle_session_reminder`。

#### 3.4.3 `spine`（脊柱）

1. 核心作用：沉淀“planner 的规范与案例”，提升计划质量和一致性。
2. 注入节点：planner system prompt（规范段 + 示例段）。
3. `spec` 最小结构：
   - `planning_principles`: 规划原则
   - `preferred_decomposition`: 任务拆解模式
   - `good_cases`: 正例
   - `bad_cases`: 反例与规避建议
4. `contract` 约束：
   - 输入：任务目标、可用工具、风险级别
   - 输出：仍使用既有 planner JSON 协议（不新增字段）
   - 失败语义：生成失败时回退到上一版 `spine`
5. 边界：不改 planner/executor 协议，不直接插入新的执行 step 类型。
6. 典型示例：`research_task_planning_guideline_v3`。

#### 3.4.4 `guard`（守卫）

1. 核心作用：沉淀“工具使用策略（tool_policy）”，约束工具调用顺序与风险优先级。
2. 注入节点：tool selection 上下文（`<policy_tools>`）。
3. `spec` 最小结构：
   - `selection_order`: 工具选择优先级
   - `risk_rules`: 高中低风险工具使用约束
   - `approval_rules`: 需人工审批的情形说明
   - `fallback_rules`: 工具失败后的替代策略
4. `contract` 约束：
   - 输入：当前任务、工具清单、工具风险配置
   - 输出：工具调用建议与限制说明
   - 失败语义：策略冲突时优先保守策略（降级到低风险工具）
5. 边界：只覆盖策略注入层；不修改工具配置层（timeout/allowlist/鉴权参数）。
6. 典型示例：`web_fetch_before_browser_automation_v2`。

#### 3.4.5 `mind`（心智）

1. 核心作用：沉淀全局行为策略（`GENE + AGENTS`），统一风格、目标与边界。
2. 注入节点：runtime 全局 system prompt 前缀层。
3. `spec` 最小结构：
   - `mission`: 全局目标与价值观
   - `behavior_rules`: 行为约束（例如先澄清再执行）
   - `collaboration_style`: 对用户交互风格
   - `safety_baseline`: 基础安全原则
4. `contract` 约束：
   - 输入：会话上下文、租户策略、用户意图
   - 输出：跨任务一致的行为基线
   - 失败语义：冲突时以安全与合规条款优先
5. 边界：不承载具体工具参数与执行步骤细节（由 `guard/hands/spine` 负责）。
6. 典型示例：`enterprise_local_agent_mindset_v1`。

### 3.5 跨对象依赖与冲突优先级

1. 优先级顺序：`mind > guard > spine > hands > reflex`（冲突时高优先级覆盖低优先级）。
2. 依赖建议：
   - `hands` 执行前必须受 `guard` 约束。
   - `spine` 规划输出应参考 `mind` 行为基线。
   - `reflex` 生成规则模板时应校验 `guard` 风险条款。
3. 冲突处理：
   - 策略冲突直接阻止发布，进入“需人工修订”状态。
   - 注入冲突保留上一稳定版本，不强行切换。

### 3.6 统一管理面（配置中心）

1. `hands/reflex/spine/guard/mind` 全部在“配置管理中心 - 进化”统一管理。
2. 配置管理中的“进化”是唯一版本治理入口。
3. 五类对象使用五个独立编辑器和独立版本轨道，可分别切换版本。
4. 人工编辑保存后自动累加版本号（`vN -> vN+1`）。
5. 版本操作统一写入审计日志并发出进化事件（`version.created/version.switched/effect.updated`）。

### 3.7 spine 进化策略（低风险路线）

1. 进化产物形态：`spine` 先沉淀为“planner 规范与案例片段”（文本/结构化模板），注入 planner system prompt。
2. 协议稳定性：不改变当前 planner 输出 JSON 结构（`goal/steps/requires_delegation/delegate_to`），避免兼容性风险。
3. 执行兼容：仍由现有 `skill/tool/mcp` 执行路径承载，不新增运行时 step 类型分支。
4. 风险控制：通过“建议性约束 + 案例”引导规划质量，失败时只需回退提示内容，不影响执行器协议。

## 4. 核心数据模型（建议）

### 4.1 learning_records

记录最小学习单元：

1. `id`, `org_id`, `agent_id`, `session_id`
2. `category`: `correction | error | feature_gap | knowledge_gap | best_practice`
3. `priority`: `low | medium | high | critical`
4. `status`: `pending | in_progress | resolved | promoted | promoted_to_capability`
5. `summary`, `details`, `suggested_action`
6. `metadata`: `source`, `related_files`, `tags`, `pattern_key`, `recurrence_count`

### 4.2 capability_candidates

1. `id`, `org_id`, `source_learning_ids[]`
2. `type`, `name`, `description`, `spec`, `contract`
3. `risk_level`: `low | medium | high`
4. `extraction_confidence`
5. `status`: `observed | applied | rolled_back | deprecated`

### 4.3 capability_releases

1. `capability_type`, `from_version`, `to_version`
2. `action` (`create_version|switch_version|rollback_version`)
3. `metrics_snapshot`（成功率、延迟、回退率、采用率）
4. `operator_id`, `change_note`, `created_at`

## 5. 事件流水线（重构版）

### 5.1 触发事件

1. `task.completed`
2. `tool.exec.completed`
3. `tool.exec.failed`
4. `user.feedback.positive`
5. `user.feedback.negative`
6. `user.corrected`

### 5.2 进化事件（标准）

1. `learning.recorded`
2. `capability.candidate.created`
3. `capability.candidate.validated`
4. `capability.version.created`
5. `capability.version.switched`
6. `capability.effect.updated`

### 5.3 阶段门禁

1. `VALIDATE`：完整性、安全、语义去重、约束校验。
2. `RECOMMEND`：阈值判定（仅复发次数/提取置信度），输出升级建议。
3. `HUMAN APPLY`：人工确认后切换版本（无灰度中间态）。
4. `OBSERVE`：线上指标观测与“建议回退”提示，不自动回退。

### 5.4 状态机、并发与幂等

候选状态机（人工驱动）：

1. `observed -> applied`（人工确认迁移）。
2. `applied -> rolled_back`（人工确认迁移）。
3. 任意状态可到 `deprecated`。

事件幂等与去重：

1. 幂等键：`org_id + trace_id + event_type + target_id + version`。
2. 同一幂等键重复事件仅处理一次，后续记审计日志但不重复执行副作用。
3. 所有状态迁移使用条件更新（CAS）：`where current_status = expected_status`。

乱序与重放：

1. 事件 envelope 必须包含 `event_seq`（单 trace 内递增）。
2. 消费者仅接受 `event_seq > last_seq` 的事件；过期事件仅入审计，不触发变更。
3. 支持事件重放时，副作用路径必须依赖幂等键。

## 6. 人工生效与回退治理

### 6.1 人工生效与回退

1. 达到建议阈值后，进化中心标记为“建议升级”。
2. 操作者在进化中心人工确认“切换到目标版本”后生效。
3. 回退由人工执行“切换到上一稳定版本”，不做自动回退。

### 6.2 观察指标（非强制）

以下指标仅用于观测、告警与人工决策参考，不作为自动应用门禁：

1. 安全违规率（相对基线变化）。
2. 平均时延退化（相对基线变化）。
3. 单次调用成本退化（相对基线变化）。

建议默认告警阈值（可调低以适配低样本）：

1. 安全违规率上升（`delta > 0`）。
2. 平均时延退化超过 `+10%`（高风险对象可用 `+5%`）。
3. 单次调用成本退化超过 `+15%`（高风险对象可用 `+8%`）。

### 6.3 效果归因规范（人工决策模式）

1. 基线定义：采用“应用前 24h”作为基线窗口。
2. 归因窗口：默认“应用后 24h”，高风险类型“应用后 72h”。
3. 关键指标：任务成功率、违规率、平均时延、平均成本、用户负反馈率。
4. 输出要求：`before/after` 差值、样本量、人工决策建议（升级/保持/回退）。

## 7. LLM 驱动进化工作流设计

本节定义“进化流水线 = LLM 驱动工作流”的执行蓝图。该工作流为全新机制，直接替换旧进化机制，不做迁移并行。

### 7.1 工作流节点

1. `collect`（事件采集）
   - 输入：`task.completed/tool.exec.* / user.feedback.* / user.corrected`
   - 输出：标准化 `learning_records`
2. `cluster`（模式聚类）
   - 输入：最近窗口内 `learning_records`
   - 输出：候选簇（同类问题合并、复发计数）
3. `propose`（LLM 候选生成）
   - 输入：候选簇 + 当前对象版本上下文（hands/reflex/spine/guard/mind）
   - 输出：`capability_candidates(spec/contract/checks/policy)`
4. `validate`（结构与约束校验）
   - 校验项：schema、对象类型合法性、内容长度、危险片段黑名单
   - 输出：`validated=true|false`
5. `gate`（建议门禁判定）
   - 规则：仅 `recurrence_count` + `extraction_confidence`
   - 输出：`recommend_apply=true|false` + `reason`
6. `human_apply`（人工生效）
   - 动作：人工确认后写入版本库，更新当前活动版本，发出 `capability.version.switched`
7. `observe`（效果观测）
   - 动作：记录观察指标（安全/时延/成本）与 before/after 归因
8. `human_rollback`（人工回退）
   - 条件：观测面板触发告警或人工判断风险上升
   - 动作：人工切换到上一稳定版本并发出 `capability.version.switched`

### 7.2 LLM 在工作流中的职责

1. 仅负责 `propose` 节点：生成候选对象内容（文本模板/注入片段）。
2. 不直接决定是否应用：`gate` 只给建议，最终由人工决策。
3. 不直接执行回退：回退动作由人工在进化中心执行。

### 7.3 对象落点（统一配置中心）

1. `hands`：可执行能力文本定义（本阶段仅文本形态，不含代码包自动生成）。
2. `reflex`：规则模板文本。
3. `spine`：planner 规范/案例注入片段。
4. `guard`：tools 策略注入片段（仅注入层，不改工具配置层）。
5. `mind`：全局行为策略（GENE + AGENTS 注入片段）。

所有对象统一在“配置管理中心 - 进化”管理版本升级与回退。

### 7.4 状态机（全新机制）

1. `observed -> applied`
2. `applied -> rolled_back`
3. `observed|applied|rolled_back -> deprecated`

### 7.5 失败处理与幂等

1. 失败重试：`collect/cluster/propose/validate` 支持重试，`human_apply/human_rollback` 必须幂等。
2. 幂等键：`org_id + trace_id + type + target_id + version`。
3. 条件更新：状态迁移必须 CAS，防止并发覆盖。
4. 事件乱序：仅处理 `event_seq > last_seq`，其余记审计不执行业务副作用。

## 8. 验收标准（DoD）

1. 任一进化候选都可追溯到 source learning 与触发事件。
2. 任一应用都可查询建议门禁记录与归因指标。
3. 进化相关阶段事件在事件中心可追踪且可回放。
4. 达到建议阈值的候选可在进化中心一键生效，且全过程有审计日志。
5. 回退由人工执行并在 1 分钟内完成切换与审计记录。
6. 任何应用都有可复现的 before/after 归因报告。
7. 任何状态迁移都可通过事件幂等键复盘且无重复副作用。

## 9. 非目标

1. 本文不规定前端最终视觉稿，只定义交互与数据契约。
2. 本文不讨论旧进化机制兼容；默认全量替换。
3. 上下文注入体系不在本文范围，见独立文档。
4. 本阶段不做工具配置层进化（仅 `guard` 注入层进化）。
5. 本阶段版本管理统一在“配置管理中心 - 进化”完成。

## 10. 关联文档

1. [进化流水线（现版）](./evolution-pipeline.md)
2. [上下文注入体系（GENE/AGENTS/TOOLS）](./context-injection-system.md)
3. [事件框架总览](./event-framework.md)
4. [关键时序](./event-sequences.md)
5. [实现级规范](./implementation-spec.md)
6. [OpenClaw Runtime Deprecation Notice](./openclaw-deprecation.md)

## 11. 实施清单（进化侧）

### 11.1 数据表 DDL（建议，精简版）

```sql
CREATE TABLE IF NOT EXISTS learning_records (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  category TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  summary TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS capability_candidates (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  type TEXT NOT NULL,
  name TEXT NOT NULL,
  spec_json TEXT NOT NULL DEFAULT '{}',
  contract_json TEXT NOT NULL DEFAULT '{}',
  source_learning_ids_json TEXT NOT NULL DEFAULT '[]',
  risk_level TEXT NOT NULL DEFAULT 'medium',
  status TEXT NOT NULL DEFAULT 'observed',
  extraction_confidence REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS capability_versions (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  capability_type TEXT NOT NULL,
  version TEXT NOT NULL,
  content_text TEXT NOT NULL,
  checksum TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(org_id, capability_type, version)
);

CREATE TABLE IF NOT EXISTS capability_releases (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  capability_type TEXT NOT NULL,
  from_version TEXT,
  to_version TEXT NOT NULL,
  action TEXT NOT NULL DEFAULT 'switch_version',
  operator_id TEXT,
  change_note TEXT,
  metrics_snapshot_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_learning_org_created ON learning_records(org_id, created_at);
CREATE INDEX IF NOT EXISTS idx_candidate_org_status ON capability_candidates(org_id, status);
CREATE INDEX IF NOT EXISTS idx_versions_org_type ON capability_versions(org_id, capability_type, created_at);
CREATE INDEX IF NOT EXISTS idx_releases_org_type ON capability_releases(org_id, capability_type, created_at);
```

一致性约束（实现要求）：

1. `capability_candidates.source_learning_ids_json` 中的 learning id 必须可追溯到同一 `org_id`。
2. `capability_versions(org_id, capability_type, version)` 唯一，禁止覆盖历史版本。
3. `status/risk_level/type/action` 使用 CHECK 约束或枚举表。
4. 所有 JSON 字段要求可解析，写入前做 schema 校验。
5. `capability_releases.from_version/to_version` 必须在 `capability_versions` 中存在（同 `org_id + capability_type`）。

### 11.2 事件 Schema（关键）

统一 envelope：

```json
{
  "id": "evt_xxx",
  "type": "capability.candidate.created",
  "org_id": "org_xxx",
  "agent_id": "agent_xxx",
  "session_id": "sess_xxx",
  "trace_id": "trace_xxx",
  "ts": "2026-03-02T15:00:00Z",
  "payload": {}
}
```

最小事件集：

1. `learning.recorded`
2. `capability.candidate.created`
3. `capability.candidate.validated`
4. `capability.version.created`
5. `capability.version.switched`
6. `capability.effect.updated`

新增字段（建议）：

1. `event_seq`：同 trace 内递增序号。
2. `idempotency_key`：幂等处理主键。
3. `target`: `{ capability_type, version }`。

### 11.3 配置管理中心（进化）UI 字段

对象列表（统一入口）：

1. 对象类型：`hands/reflex/spine/guard/mind`
2. 当前版本
3. 最近更新时间
4. 最近版本动作（switched/edited）
5. 操作：编辑、切换版本、回退版本、查看历史

对象详情（统一结构）：

1. 当前内容编辑器（文本/模板，独立于每个对象）
2. 版本时间线（版本号、变更说明、操作者、时间）
3. 建议门禁记录（复发次数、提取置信度）
4. 观察指标面板（安全违规率、平均时延退化、单次调用成本退化）
5. 审计事件（version.created/version.switched/effect.updated）
6. 操作区：保存新版本、切换版本、回退到指定版本

### 11.4 实施顺序（建议）

1. 工作流引擎：`collect -> cluster -> propose -> validate -> gate(recommend) -> human_apply -> observe -> human_rollback`
2. 版本中心：五类对象统一版本管理与回退
3. 事件中心：全链路事件与审计对齐
4. 配置中心：进化页统一入口
