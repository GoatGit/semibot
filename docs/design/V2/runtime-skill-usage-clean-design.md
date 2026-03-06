# Runtime Skill Usage Clean Design (V2)

## 1. 目标

本文档定义 `semibot` runtime 的技能使用机制基线设计。

目标：

1. 让 LLM 更稳定地遵循 `SKILL.md`
2. 避免 runtime 臆造技能入口、脚本命令和中间产物
3. 用单一技能模型处理所有技能
4. 让计划、执行、验证三层边界清晰

本文档是干净重写版，不继承旧策略中的“预设入口脚本”“phase 到脚本映射”“隐式中间文件”假设。

## 2. 核心判断

### 2.1 技能的主协议是 `SKILL.md`

默认情况下，技能首先是文档协议，而不是可执行程序。

这意味着：

1. `SKILL.md` 决定该技能如何被理解和使用
2. `scripts/` 目录表示“可能存在辅助执行能力”，不代表天然有稳定入口
3. runtime 不能因为技能有脚本，就自动推断：
   - 入口脚本是谁
   - phase 对应哪个脚本
   - 中间产物叫什么名字

### 2.2 `SKILL.md` 负责方法论，runtime 负责执行契约

`SKILL.md` 提供：

1. 适用场景
2. 工作流程
3. 资源加载时机
4. 验证要求
5. 输出格式要求

runtime 提供：

1. 技能发现与选择
2. 文档注入
3. 资源按需读取
4. 工具 schema
5. 脚本白名单与参数校验
6. artifact 契约
7. 失败阻断与 replan

### 2.3 对齐 OpenClaw，但不复制实现

要对齐的是原则：

1. 先注入技能索引
2. 命中后再读取 `SKILL.md`
3. 让模型按文档驱动使用通用工具
4. runtime 只做执行边界与错误护栏

不对齐的部分：

1. 不要求完全复制 `openclaw` 的 prompt 格式
2. 不要求复制其 session 组织
3. 不要求复制其工具命名

### 2.4 单轮单技能

本设计明确采用：

1. 单轮只允许一个主技能
2. 同一轮不允许多个技能同时注入或同时主导计划
3. 其他 skill 不能以“辅助技能”身份进入同一轮

原因：

1. `SKILL.md` 承担方法论职责，多份 `SKILL.md` 同时进入上下文会互相污染
2. “辅助技能”边界不稳定，仍可能携带自己的流程约束
3. 单轮单技能是最符合“`SKILL.md` 负责方法论”这一前提的模型

## 3. 单一技能模型

本设计取消 `instruction` 与 `package` 类型区分，所有技能统一按一种模型处理：

- `hybrid`

这里的 `hybrid` 不是“必须同时有文档和脚本”，而是一个统一的能力容器：

1. 技能总是以 `SKILL.md` 为主协议
2. 技能可以只有文档
3. 技能也可以带脚本、模板、参考资料、静态资源
4. 是否调用脚本，不由类型决定，而由文档、资源事实、工具能力和 artifact 契约共同决定

### 3.1 为什么取消 `instruction`

原因：

1. 纯文档技能本质上就是“只有文档能力的 hybrid”
2. 单独保留 `instruction` 只会增加路由和实现分支
3. 运行时真正关心的是资源事实，不是名义类型

### 3.2 为什么取消 `package`

原因：

1. 当前技能库里几乎没有明显纯正的 `package` 技能
2. 许多带脚本的技能仍然是文档驱动工作流，不应被视为直接可执行包
3. “存在稳定入口”更适合作为能力事实字段，而不是 skill 类型

### 3.3 运行时如何区分能力

虽然不再区分类型，但仍要记录能力事实：

1. `has_skill_md`
2. `script_files`
3. `has_references`
4. `has_templates`
5. `declares_stable_entry` 可选
6. `validation_scripts` 可选

也就是说：

1. 不再靠“类型”判断怎么执行
2. 改为靠“该技能实际具备哪些资源与能力”判断执行路径
3. 但单轮内仍只有一个主技能，能力事实不改变这一约束

## 4. 总体流程

```text
用户请求
  -> 技能索引注入
  -> 技能选择
  -> 读取目标 SKILL.md
  -> 当前轮计划
  -> 计划后校验
  -> 执行步骤
  -> 执行前 guard
  -> observe
  -> 当前轮失败则 replan
  -> 当前轮成功且整体完成则结束
  -> 当前轮成功但整体目标未完成则进入下一轮规划
```

## 5. 五层机制

### 5.1 Level 1: Skill Index

系统 prompt 中始终注入轻量技能索引，而不是注入技能正文。

每个技能索引至少包含：

1. `skill_id`
2. `name`
3. `description`
4. `has_skill_md`
5. `SKILL.md` 路径
6. `script_files`
7. `has_references`
8. `has_templates`
9. `declares_stable_entry` 可选

作用：

1. 帮助 LLM 先做技能选择
2. 降低 prompt 膨胀
3. 避免未命中前就读无关技能正文
4. 让 planner 根据资源事实而非技能类型做判断

### 5.2 Level 2: SKILL.md Injection

每次进入 `plan`，runtime 都重新经过技能理解关口，并为本轮选中的技能重新注入 `SKILL.md`。

要求：

1. 先基于技能索引重新做技能选择
2. 再为本轮选中的技能注入 `SKILL.md`
3. 注入方式使用 tool-context 消息，不伪装成系统规则

`SKILL.md` 注入后，LLM 应依据其中流程组织计划，而不是 runtime 预先替它展开 phase 细节。

约束：

1. 单轮只允许注入一个技能的 `SKILL.md`
2. 如果要切换技能，必须发生在轮次边界
3. 技能切换不能发生在同一轮 plan 内

### 5.3 Level 3: Progressive Resource Loading

`reference/`、`templates/`、`assets/` 等资源不预加载。

按需规则：

1. 先读 `SKILL.md`
2. 命中文档中引用的资源时，再读取对应文件
3. 只读取当前步骤所需文件，不批量递归加载

白名单目录：

1. `SKILL.md`
2. `reference/`
3. `references/`
4. `templates/`
5. `assets/`

默认不允许：

1. `tests/`
2. 非白名单目录
3. 越权路径
4. 符号链接逃逸

### 5.4 Level 4: Plan Validation

计划生成后不能直接执行，必须做 skill-flow 校验。

校验目标：

1. 计划是否体现了 `SKILL.md` 的基本要求
2. 是否缺少关键阶段
3. 是否引用了不存在的 artifact
4. 是否错误把 skill 当成直接可执行工具

至少应检查：

1. 命中技能后是否已注入或读取 `SKILL.md`
2. 是否存在与任务类型匹配的核心步骤
3. 是否存在验证步骤
4. 文件型输入是否有前序来源
5. `skill_source` provenance 是否一致
6. 当前轮是否只包含一个主技能来源

不通过时：

1. 阻断执行
2. 触发重新进入 `plan`
3. 不做“猜测式补丁改写”

### 5.5 Level 5: Execution Guard

执行前 runtime 只做通用 guard，不做技能特化改写。

包括：

1. 脚本路径必须在 `skill/scripts/`
2. 目标必须真实存在且是文件
3. 参数必须通过 `--help` 或静态解析预检
4. claimed artifact 必须真实存在
5. 若输入 artifact 无来源，则阻断

## 6. Artifact 契约

### 6.1 原则

后续步骤不能假设文件自然存在。

每个 artifact 必须显式具备：

1. 逻辑类型
2. 生产步骤
3. 物理路径或内存对象
4. 消费步骤

### 6.2 推荐逻辑类型

1. `search_results`
2. `search_results_json`
3. `report_md`
4. `report_html`
5. `report_pdf`
6. `citation_verification_result`
7. `report_validation_result`

### 6.3 规则

1. 如果脚本要读文件，前面必须有明确 artifact 生成来源
2. 如果工具结果只在内存中存在，而后一步需要文件，必须先加入显式物化步骤
3. runtime 不得凭空发明 `search_results.json` 这类文件名
4. stdout 声称生成产物，不等于 artifact 已存在；必须校验磁盘真实文件

## 7. 轮次模型与 Observe

### 7.1 单轮定义

一轮（round）表示：

1. 一个主技能
2. 一组围绕该技能目标生成的计划
3. 一组在同一主技能方法论下完成的步骤

当前轮结束时，必须由 `observe` 判定：

1. 当前轮是否成功
2. 整体用户目标是否成功
3. 是否进入下一轮

### 7.2 Observe 的四种输出

`observe` 必须支持四种状态：

1. `task_completed`
   - 当前轮成功
   - 整体用户目标也成功

2. `continue_execution`
   - 当前轮未结束
   - 当前计划还能继续执行

3. `replan_current_round`
   - 当前轮未成功
   - 当前计划不能继续
   - 需要在“当前轮未完成”的语义下重新规划

4. `plan_next_round`
   - 当前轮已经成功完成
   - 但整体用户目标尚未完成
   - 需要基于当前轮 artifact 开启下一轮规划

### 7.3 `replan` 与“下一轮规划”的区别

两者的核心区别，不是能不能切换主技能，而是对当前轮完成态的判断不同。

`replan_current_round`：

1. 当前轮被判定为失败、未完成或未达标
2. 当前轮产物通常是待修复产物或不可依赖产物
3. 可以保持主技能，也可以切换主技能
4. 语义上仍属于“修当前轮”

`plan_next_round`：

1. 当前轮被判定为成功完成
2. 当前轮产物是正式可交接 artifact
3. 下一轮可以保持主技能，也可以切换主技能
4. 语义上属于“当前轮收尾后进入下一轮”

因此：

1. `replan_current_round` 不能替代 `plan_next_round`
2. 否则会混淆当前轮成功/失败语义
3. 也会污染 artifact 生命周期与 UI/审计语义

### 7.4 跨轮技能切换

单轮单技能不等于整个任务只能使用一个技能。

规则是：

1. 同一轮只允许一个技能
2. 多技能协作只能通过多轮完成
3. 轮次之间通过 artifact 交接

例如：

1. 第一轮：`deep-research` 生成 `report_md`
2. 第二轮：`pdf` 读取 `report_md` 生成 `report_pdf`

前提：

1. 第一轮产物必须真实存在
2. 第二轮必须显式消费上一轮 artifact
3. 不允许把两个 skill 放在同一轮里共同主导

### 7.5 `replan` 与 `next_round` 的共同点

两者虽然语义不同，但都必须重新经过技能理解关口。

规则：

1. 每次进入 `plan` 都重新执行技能选择
2. 每次进入 `plan` 都重新注入本轮选中技能的 `SKILL.md`
3. 不依赖“上一次已经注入过”的缓存语义跳过技能理解
4. 稳定性优先于注入去重优化
## 8. `deep-research` 的标准执行链

对于 `deep-research`，标准执行链应是：

1. 命中技能
2. 注入 `SKILL.md`
3. 按需读取 `reference/methodology.md`
4. 使用内建搜索/抓取工具执行研究主流程
5. 整理检索结果为显式 artifact
6. 生成 markdown 主报告
7. 运行 `verify_citations.py`
8. 运行 `validate_report.py`
9. 生成 HTML
10. 生成 PDF

不应出现的行为：

1. 直接把 `research_engine.py` 当作完整研究入口
2. 用 phase 名自动映射脚本名
3. 凭空出现 `search_results.json`
4. 让不存在的 `report.md` 进入验证环节
5. 只因为 stdout 打印了报告路径就视为成功

如果用户目标额外要求 PDF，而当前轮主技能是 `deep-research`，则：

1. 第一轮只完成 `deep-research` 目标
2. `observe` 若判定当前轮成功但整体目标未完成，应输出 `plan_next_round`
3. 第二轮再切换到 `pdf` 技能处理 `report_md -> report_pdf`
## 9. Prompt 设计要求

### 8.1 要做的

1. 注入技能索引
2. 命中后注入 `SKILL.md`
3. 提供当前可用工具 schema
4. 提供真实 `scripts/` 文件列表
5. 提供 artifact 规则摘要
6. 明确同一轮只允许一个主技能

### 8.2 不要做的

1. 不注入某个技能专属的 phase 模板提示词
2. 不把旧策略里的入口脚本假设写进 planner prompt
3. 不用正则硬解析 `SKILL.md` 为 CLI 契约
4. 不让 prompt 暗示不存在的中间文件
5. 不让 prompt 暗示同一轮可以混用多个技能

## 10. Replan 机制

`replan_current_round` 与 `plan_next_round` 都必须重新进入 `plan`，并重新经过技能理解关口。

规则：

1. `replan_current_round` 进入 `plan` 时，要重新选择当前轮应由哪个技能主导，并重新注入该技能的 `SKILL.md`
2. `plan_next_round` 进入 `plan` 时，也要重新选择下一轮应由哪个技能主导，并重新注入该技能的 `SKILL.md`
3. `replan_current_round` 可以切换主技能，但语义上当前轮仍视为未完成
4. `plan_next_round` 可以切换主技能，但前提是当前轮已成功完成
5. 若失败原因是 artifact 缺失或脚本契约失败，应优先 `replan_current_round`

## 11. 实现落点

建议对应模块：

1. `runtime/src/skills/index_manager.py`
2. `runtime/src/skills/skill_index_prompt.py`
3. `runtime/src/skills/file_io.py`
4. `runtime/src/skills/execution_guard.py`
5. `runtime/src/skills/skill_script_runner.py`
6. `runtime/src/orchestrator/nodes.py`
7. `runtime/src/orchestrator/context.py`

## 12. 验收标准

1. 每次进入 `plan` 都会重新执行技能选择
2. 每次进入 `plan` 都会重新注入本轮选中 skill 的 `SKILL.md`
3. 技能切换后可正确注入新 skill
4. 非白名单资源无法读取
5. 不存在的脚本路径会被阻断
6. 已知错误参数会被阻断
7. 缺失 artifact 会触发 replan
8. claimed artifact 不存在时执行失败
9. `deep-research` 不再出现隐式 `search_results.json`
10. `deep-research` 的报告验证步骤只消费真实存在的 `report_md`
11. 同一轮不会出现两个不同 skill 的 `SKILL.md` 注入
12. `observe` 能正确区分 `replan_current_round` 与 `plan_next_round`

## 13. 结论

`semibot` 的技能机制应回到一个更简单、干净、通用的模型：

1. 技能由 `SKILL.md` 定义如何使用
2. 同一轮只允许一个技能主导方法论
3. runtime 只负责帮助模型更容易遵循这个协议
4. 执行层只做通用边界与契约校验

一句话总结：

**技能的主协议来自 `SKILL.md`；同一轮只允许一个技能主导，runtime 不再替技能发明入口、脚本映射和中间产物。**
