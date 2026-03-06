# Runtime Skill Manifest Cache Design (V2)

## 1. 背景与目标

当前技能编排在 replan 场景下存在两个核心问题：

1. 同一会话多轮重复做技能理解，开销高且不稳定。
2. 计划生成容易出现“脚本存在但参数不匹配”或“阶段语义被误当脚本命令”。

本设计目标：

1. 保留 `SKILL.md` 读取与注入能力。
2. 将技能理解从“每轮计划动作”升级为“会话级缓存资产”。
3. 支持多技能并行理解与多轮复用，同时保持通用机制（不特化 deep-research）。

## 2. 设计原则

1. 通用优先：不依赖特定技能的 phase、命名风格或目录特征。
2. 契约驱动：计划和执行都基于 manifest 契约，而非自由文本猜测。
3. 会话复用：同一 session 内默认复用 manifest cache，不做无意义重复解析。
4. 局部失效：缓存按技能粒度失效，不做全量清空。
5. 安全边界：仅允许技能根目录白名单文件读取与脚本执行。
6. `SKILL.md` 语义优先但非结构化契约源：不从自由 Markdown 强行确定性推导 CLI 参数。

## 3. 核心概念

### 3.1 SkillExecutionManifest

每个技能在 runtime 被解析为统一结构：

- `skill_id`
- `skill_root`
- `skill_md`（完整或分片）
- `script_inventory`（真实脚本清单）
- `script_cli_contracts`（脚本支持的参数、必填项、示例命令）
- `artifact_contracts`（md/html/pdf/json 等产物与消费关系）
- `tool_hints`（从 SKILL.md 抽取的工具使用偏好，仅作提示）
- `checksum` / `mtime_fingerprint`
- `manifest_version`
- `parsed_at`

### 3.2 SessionSkillManifestCache

会话级缓存结构：

- `session_id`
- `manifests: Map<skill_id, SkillExecutionManifest>`
- `candidate_skill_ids`
- `cache_version`
- `last_refresh_at`

### 3.3 CLI 契约来源优先级（关键）

`SKILL.md` 是自由格式 Markdown，不作为 CLI 契约的确定性来源。  
`script_cli_contracts` 仅来自以下可验证来源（按优先级）：

1. 技能内显式机器可读文件（如 `skill.manifest.json`、`scripts/*.schema.json`，如果存在）。
2. 脚本自描述接口（`--help`、`-h` 可解析输出）。
3. 语言级静态提取（如 Python `argparse.add_argument`，仅作为保守补充）。
4. 若以上都不可得：降级为“仅路径白名单执行”，不做参数强校验。

非目标：

1. 不用正则从 `SKILL.md` 文本硬解析参数契约。
2. 不依赖 LLM 在线解析 `SKILL.md` 生成参数契约（避免开销与不稳定）。

## 4. 生命周期

### 4.1 初始化（首次计划前）

1. 技能发现：基于用户请求 + agent 可用技能，得到候选技能集。
2. 一次理解多个技能：批量生成各技能 manifest。
3. 注入计划上下文：
   - 保留 `SKILL.md` 注入；
   - 同时注入 manifest 摘要（脚本白名单、CLI 契约、产物契约）。

### 4.2 Replan（后续轮次）

1. 默认复用同一份 `SessionSkillManifestCache`。
2. 若 replan 切换技能：读取该技能 manifest（已有则直接用，无则懒加载）。
3. 不重复跑已命中且未失效的技能理解流程。

### 4.3 失效与刷新（按技能粒度）

仅在以下情形触发某技能 manifest 重建：

1. `SKILL.md` / `scripts/` / `reference/` / `templates/` 指纹变化。
2. 首次进入会话时该技能未缓存。
3. 执行阶段返回“契约缺失/契约冲突”。
4. 显式调试刷新请求。

## 5. 计划阶段规则

### 5.1 输入材料

给 planner 的技能上下文由两层组成：

1. `SKILL.md`（原文语义，保留）
2. Manifest 摘要（结构化约束）

说明：`SKILL.md` 注入用于语义决策、步骤意图和方法指导；不承担参数 schema 的机器契约职责。

### 5.2 约束内容（通用）

1. 可执行脚本必须命中 `script_inventory`。
2. 脚本参数必须满足对应 `script_cli_contract`。
3. 产物流转必须满足 `artifact_contract`（如 `validate_report` 只能接收 md 报告）。
4. 未满足契约的步骤不得进入执行队列。

说明：不注入任何技能特定 phase 规则，不做 deep-research 特化硬编码。

## 6. 执行阶段规则

### 6.1 skill_script_runner

执行前做三层校验：

1. 路径校验：脚本必须位于 `skill_root/scripts` 白名单内。
2. 参数校验：命令参数与 `script_cli_contract` 对齐（必填项、参数名、类型）。
3. 产物校验：输入输出文件类型满足 `artifact_contract`。

### 6.2 失败处理

当校验失败：

1. 返回结构化错误（`reason`, `expected_contract`, `available_commands`）。
2. 触发 replan，并附带候选可执行命令。
3. 不进行隐式特化重写（避免“看起来成功，实际偏离技能意图”）。

## 7. 多技能编排

每轮编排可使用多个技能，但建议“主技能 + 辅技能”模式：

1. 主技能负责核心任务（如研究）。
2. 辅技能负责特定子能力（如 PDF 生成）。
3. 每个技能独立使用其 manifest 契约校验。
4. 同一会话复用同一份多技能 cache。

## 8. 数据结构建议

```text
SessionContext.metadata.skill_manifest_cache = {
  "session_id": "...",
  "cache_version": "v1",
  "manifests": {
    "deep-research": { ...SkillExecutionManifest... },
    "generating-pdf": { ...SkillExecutionManifest... }
  },
  "candidate_skill_ids": ["deep-research", "generating-pdf"],
  "last_refresh_at": "..."
}
```

## 9. 落点建议（代码）

1. `runtime/src/skills/manifest_builder.py`
   - 解析 SKILL.md（语义层）、扫描脚本、从可验证来源提取 CLI 契约、建立 artifact 契约。
2. `runtime/src/skills/manifest_cache.py`
   - session 级缓存读写、失效判断、按技能刷新。
3. `runtime/src/orchestrator/nodes.py`
   - 计划前加载/复用 cache；注入 manifest 摘要到 planner。
4. `runtime/src/skills/skill_script_runner.py`
   - 执行前契约校验，失败返回结构化建议。

## 10. 验收标准

1. 同一 session 多轮 replan 不重复解析未变化技能。
2. replan 切换技能时可复用已有 manifest，缺失时懒加载。
3. 不再出现“脚本存在但参数名错误”导致的盲执行失败。
4. 不再依赖 phase 术语进行特化改写。
5. deep-research 可完整走“文档驱动 + 脚本验证”路径，同时机制对所有技能通用。

## 11. 对 deep-research 的适配结论（在通用机制下）

1. deep-research 属于 hybrid：
   - 主体执行是文档驱动的研究编排；
   - 脚本主要用于验证/转换等可执行环节。
2. `research_engine.py` 需要 `--query`，不支持 `--phase` 等参数。
3. `validate_report.py` / `verify_citations.py` 的 `--report` 语义是 markdown 报告，不是 PDF。

以上都应由通用 manifest 契约保障，而非 deep-research 特化逻辑。
