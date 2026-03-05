# Runtime 技能使用设计与改造清单（V2）

## 1. 背景与目标

当前 semibot runtime 对技能的可执行判定过于依赖 `scripts/main.py`，导致像 `deep-research` 这类“文档驱动 + 多脚本 + 模板/参考资料”的复杂技能无法被准确、全面利用。

本设计目标：

1. 不修改外部引入技能内容（包括 `~/.semibot/skills/*`）。
2. 让 runtime 按 `SKILL.md` 驱动执行决策。
3. 在能力不足时再进入安装兜底，不将安装作为默认流程。
4. 提升复杂技能（如 deep-research）可用性和可控性。
5. 所有机制必须对“任意技能”通用生效，禁止为单一技能做特化分支。

通用性原则（强约束）：

1. 不允许出现 `if skill_name == "deep-research"` 一类的特化逻辑。
2. 技能分类、门控、文件读取安全、能力缺口判定、安装策略，均以统一规则实现。
3. deep-research 仅作为回归与验收样例，不作为产品逻辑中的特殊对象。

## 2. 技能类型模型（V2）

### 2.1 instruction

定义：
- 有 `SKILL.md`。
- 不要求存在 `scripts/main.py` 单入口。

执行方式：
1. 先读取 `SKILL.md`。
2. 根据文档指示按需读取其他文件（`reference/*`、`templates/*`、`scripts/*`）。
3. 调用现有工具执行（如 `browser_automation`、`code_executor`、`file_io`、`pdf` 等）。

适用：方法论/流程型技能。

### 2.2 package

定义：
- 具备明确可执行入口（当前兼容 `scripts/main.py`）。
- V2 推荐同时提供 `SKILL.md`，用于流程约束与可解释性。
- 兼容历史包：允许“仅入口、无 `SKILL.md`”的 legacy package 存在。

执行方式：
1. 有 `SKILL.md` 的 package：先读 `SKILL.md`，再执行入口。
2. 无 `SKILL.md` 的 legacy package：走兼容分支，不阻断执行，但记录告警并建议补齐。

适用：单入口封装型技能。

### 2.3 hybrid（新增）

定义：
- 同时具备文档编排能力（`SKILL.md`）与可执行资产（一个或多个脚本/命令入口）。

执行方式：
1. 默认先读 `SKILL.md` 确认流程与约束。
2. 按文档指示选择直接调用可执行入口或调用通用工具链。

适用：复杂技能（deep-research 属于该类目标形态）。

## 3. Runtime 标准技能执行流程

1. 理解用户问题。
2. 选择最匹配技能（基于技能描述/标签/语义，不仅依赖“可执行入口”）。
3. 命中技能后执行门控：
   - 若存在 `SKILL.md`：首步读取 `SKILL.md`。
   - 若为 legacy package 且无 `SKILL.md`：走兼容分支，不阻断执行。
4. 解析 `SKILL.md` 指示后，按需读取附属文件（禁止无条件全量递归读）。
5. 生成计划并执行：
   - 优先使用已存在能力（内建工具、MCP、已安装技能）。
   - 仅在明确能力缺口时触发 `skill_installer`。
6. 若触发安装，需走审批与风险控制。

### 3.1 技能理解（Understand）

输入：
- 用户请求（原始消息、上下文、历史对话）。
- 技能目录索引（技能名、描述、类型、可用状态、约束）。

处理：
1. 识别任务意图与目标产出（分析、报告、网页操作、文件产出等）。
2. 在可用技能中做语义匹配，确定“最可能命中的技能候选”。
3. 若命中技能，设置 `selected_skill`，并打上“读 SKILL.md（若存在）”门控标记。

输出：
- `selected_skill`（可能为空）。
- `skill_gate = read_skill_md_if_exists`（命中技能时为 true）。

### 3.2 技能注入（Inject）

输入：
- `selected_skill`。
- 运行时可用工具/技能能力集合。

处理：
1. 向 planner 注入结构化技能上下文，而非整包全文：
   - 技能名、描述、类型（instruction/package/hybrid）。
   - 可读取入口：`read_skill_file`。
   - 执行约束：先读 `SKILL.md`，再按文档决定后续读取/执行。
2. 不注入全量 `reference/templates/scripts` 内容，只注入“可按需读取”的提示。
3. 注入安装策略约束：安装是 fallback，不是默认步骤。

输出：
- 带技能约束的规划上下文（planner context）。

### 3.3 技能编排（Orchestrate）

输入：
- 带技能约束的 planner context。

处理：
1. 生成执行计划时执行门控首步：
   - 存在 `SKILL.md`：`read_skill_file(skill_name=<selected_skill>, file_path=\"SKILL.md\")`。
   - 不存在 `SKILL.md` 且为 legacy package：进入兼容路径并打审计标记。
2. 读取 `SKILL.md` 后，基于文档指示生成后续步骤：
   - 需要时读取 `reference/*`、`templates/*`、`scripts/*` 指定文件。
   - 选择调用已有工具（browser/code/file/pdf/mcp...）。
3. 若步骤中出现“调用其他技能/安装技能”指示，执行能力缺口判定：
   - 当前工具或已安装技能可完成：禁止安装，改用现有能力。
   - 明确不可完成：才允许规划 `skill_installer`，并进入审批流。

输出：
- 可执行计划（含技能文件读取步骤、工具调用步骤、可选安装步骤）。

### 3.4 技能执行（Execute）

输入：
- 可执行计划。

处理：
1. 按顺序执行，优先保证技能门控步骤已满足（已读 `SKILL.md`）。
2. 执行过程中记录 trace：
   - 读取了哪些技能文件。
   - 调用了哪些工具/脚本。
   - 是否触发安装，以及触发原因。
3. 若安装步骤被拒绝或失败，回退到“仅用现有能力”的重规划路径。

输出：
- 最终结果（回复、文件、报告）。
- 可审计执行轨迹（用于排错与验收）。

## 4. 通用机制与 deep-research 验证样例

## 4.1 通用机制要求（适用于所有技能）

1. 任意技能命中后均走统一门控与编排流程。
2. 任意技能文件读取均走统一安全边界。
3. 任意技能安装决策均走统一能力缺口判定。
4. 任意技能均适用统一的选择稳定规则与降级路径。

## 4.2 deep-research 当前可用能力（作为样例）

- 可读取 `SKILL.md` 与目录内指定文件。
- 可借助已有工具执行部分流程（搜索、浏览器、代码执行、文件读写）。

## 4.3 当前不足（通用层）

1. 缺少“文档驱动的技能执行编排层”。
2. 过早触发安装兜底（planner 中 capability gap 提示偏激进）。
3. 对多脚本、多参考文件的使用缺少标准化加载策略。

## 4.4 目标行为（以 deep-research 为验证样例）

针对 deep-research：
1. 先读 `SKILL.md`。
2. 按其明确步骤读取 `reference/methodology.md`、`templates/*`、需要的 `scripts/*`。
3. 若所需动作可由现有工具完成，不安装任何新技能。
4. 只有当文档要求且现有能力确实不足时，才触发 `skill_installer`（审批后执行）。

## 4.5 文件读取安全边界（必须）

“按 SKILL.md 指示读取”必须在安全边界内执行，防止越权读取。

1. 路径边界：
   - 仅允许技能根目录内相对路径。
   - 统一做路径规范化（normalize + resolve）后校验仍在技能根内。
   - 禁止绝对路径、`..`、软链接跳出技能根。
2. 目录白名单：
   - 允许：`SKILL.md`、`REFERENCE.md`、`manifest.json`、`scripts/*`、`reference/*`、`templates/*`。
   - 其他目录默认拒绝，除非显式放行。
3. 文件与内容限制：
   - 单文件大小上限（建议 1MB）。
   - 单次任务总读取预算上限（建议 5MB 或 N 文件）。
   - 仅文本文件默认可读；二进制文件默认拒绝。
4. 敏感信息策略：
   - 禁止读取环境变量文件、密钥文件、系统路径文件。
   - 命中敏感路径返回明确拒绝原因并记录审计日志。

## 4.6 能力缺口结构化判定（必须）

能力缺口不能只靠提示词，必须结构化判定并附证据。

1. 判定输入：
   - 目标动作清单（由计划步骤抽取）。
   - 可用能力矩阵（工具/技能/MCP 的动作覆盖）。
2. 判定输出：
   - `gap=true/false`。
   - `missing_capabilities=[...]`。
   - `evidence=[为何现有能力不可满足]`。
3. 安装触发条件：
   - 仅当 `gap=true` 且证据充分时，才允许规划 `skill_installer`。
   - 否则必须回退“仅用现有能力”的重规划路径。

## 4.7 技能选择稳定规则（必须）

为避免“最匹配技能”不稳定，采用确定性规则：

1. 评分维度（可配置权重）：
   - 名称/别名匹配分。
   - 描述语义相似度分。
   - 标签/领域匹配分。
   - 可用性惩罚（缺依赖、被禁用、OS 不兼容）。
2. 并列打破规则：
   - 先比较可用性，再比较专用性（更窄域优先），再按技能名排序。
3. 多技能串联：
   - 默认单技能优先。
   - 仅当主技能 `SKILL.md` 明确要求调用其他技能时，才允许串联。
4. 不命中降级路径：
   - 无技能命中时，直接走通用工具规划，不触发“强制读 SKILL.md”。

## 5. 改造清单（按优先级）

### P0（必须）

1. 引入三态类型：`instruction` / `package` / `hybrid`。
2. 将 `SKILL.md` 作为技能识别一等入口，不再仅以 `scripts/main.py` 判断“是否是可用技能”。
3. 增加“读 SKILL.md（若存在）”执行门控：命中技能后，优先读取 `SKILL.md`；legacy package 无 `SKILL.md` 不阻断。
4. 收紧 `skill_installer` 触发条件：
   - 必须存在结构化能力缺口（含证据）。
   - 必须确认当前工具与已安装技能无法完成。
5. 固化文件读取安全边界（路径规范化、白名单、大小预算、敏感文件拒绝）。
6. 固化技能选择稳定规则（评分、并列打破、多技能串联条件、不命中降级）。

### P1（强烈建议）

1. 新增 `hybrid` 路由器：
   - 先文档解析，再按文档选择脚本/工具调用。
2. 扩展技能文件索引能力：
   - 支持 `reference/`、`templates/`、`scripts/` 文件可发现性。
   - 但保持“按需读取”，不做全量注入。
3. 增加技能执行 trace：
   - 记录“读取了哪些技能文件”“为何触发安装”。

### P2（增强）

1. 技能资格评估（对齐 OpenClaw 思路）：
   - OS/bin/env/config 要求检查。
2. 技能快照与热更新（监听 `SKILL.md` 变化）。
3. 针对复杂技能增加“分阶段上下文预算”控制，防止上下文污染。

## 6. 代码落点建议

1. `runtime/src/skills/index_manager.py`
- 扩展 kind 判定逻辑：支持 `hybrid`，并把 `SKILL.md` 技能纳入一等索引。

2. `runtime/src/skills/package_loader.py`
- 不再只围绕 `scripts/main.py`；为 `instruction/hybrid` 提供注册元数据（非直接脚本执行）。

3. `runtime/src/session/semigraph_adapter.py`
- `_register_package_tools` 扩展为 `_register_skill_capabilities`：
  - package: 注册直接工具。
  - instruction/hybrid: 注册文档驱动能力入口（由 planner+executor 路由）。

4. `runtime/src/llm/base.py`
- 下调/收紧 capability gap 自动安装提示。
- 明确“先读技能文档，再决定是否安装”。

5. `runtime/src/orchestrator/nodes.py`（新增关键落点）
- 在 planner 阶段注入“读 SKILL.md（若存在）”硬约束。
- 在执行阶段做门控校验与 legacy package 兼容分支。
- 在重规划阶段接入结构化能力缺口判定结果，禁止无证据安装。

6. `apps/api/src/services/skill-prompt-builder.ts`
- 将技能提示改为“先读 SKILL.md，再按指示读取附属文件”。
- 明确“安装是最后兜底”。

7. `apps/api/src/services/skill-file.service.ts`
- 固化安全边界（路径、软链接、大小预算、敏感文件策略）。
- 补充目录清单能力（可选）用于按需发现文件。

## 7. 验收标准

1. 对 deep-research 发起任务时：
   - 有 `SKILL.md` 时首次必读；无 `SKILL.md` 的 legacy package 不阻断且有告警。
   - 后续仅按文档提示读取 `reference/templates/scripts`。
2. 在已有工具可完成时，不触发 `skill_installer`。
3. 仅在能力缺口明确且审批通过时触发安装。
4. 日志可追溯：
   - 技能选择依据。
   - 文件读取序列。
   - 安装触发原因。

## 7.1 开放问题决议

1. package 是否强制补 `SKILL.md`？
   - 结论：新建 package/hybrid 强制；历史 package 走兼容分支不阻断。
   - 策略：迁移窗口内告警，窗口结束后可升级为强制。
2. “能力缺口”是否结构化判定？
   - 结论：是。必须输出 `gap/missing_capabilities/evidence`，禁止仅凭提示词判断。
3. 文件读取是否限定白名单与上限？
   - 结论：是。必须执行“技能根目录白名单 + 路径规范化 + 软链接防逃逸 + 单文件/总量上限”。

## 8. 非目标

1. 不改第三方技能目录结构。
2. 不要求所有技能都改成 `scripts/main.py` 单入口。
3. 不做一次性全目录全文加载。

## 9. 迁移策略

1. 保持现有 `package` 路径兼容。
2. 在不影响线上行为前提下引入 `instruction/hybrid`。
3. 通过灰度开关启用“先读 SKILL.md”门控与“安装兜底收紧策略”。
4. 为 legacy package 设置迁移窗口：逐步补齐 `SKILL.md`，到期后可切为强制。

---

本文件是 runtime 技能策略升级的设计基线，后续实现需配套测试：
- 单元测试：kind 判定、安装触发条件、文档门控。
- 集成测试：deep-research 全链路（新会话、选专家、执行研究、审批分支）。
