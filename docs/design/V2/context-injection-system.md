# 上下文注入体系（GENE/AGENTS/TOOLS）

> 目标：将 `GENE.md / AGENTS.md / TOOLS.md` 纳入统一的 runtime 注入与进化治理闭环，确保行为一致、执行稳定、工具可控。

## 1. 命名与职责

## 1.1 命名变更

1. 旧名：`SOUL.md`
2. 新名：`GENE.md`
3. 语义：从“人格描述”收敛为“行为基因约束（Behavioral DNA）”

## 1.2 三个文档的职责边界

1. `GENE.md`
   - 行为原则、价值观、风险偏好、沟通边界
   - 关注“应该如何行动与表达”
2. `AGENTS.md`
   - 多智能体流程、拆解/委派/回退策略
   - 关注“任务如何被组织与执行”
3. `TOOLS.md`
   - 工具能力边界、参数规范、集成坑点、故障处理
   - 关注“工具如何被安全且高成功率地调用”

## 1.3 存储与编辑策略（已确认）

1. `GENE.md / AGENTS.md / TOOLS.md` 的唯一真源在数据库（`context_policy_docs`）。
2. 配置管理中心提供在线编辑、版本发布、回滚入口。
3. 文件系统不作为运行时真源；如需导出，仅作为只读快照/备份。

## 2. 注入时序与优先级

## 2.1 注入节点

在 `START -> PLAN -> ACT -> RESPOND -> REFLECT` 全链路可见，至少保证：

1. PLAN 前注入（影响策略与步骤规划）
2. RESPOND 前注入（保证表达与边界一致）
3. REFLECT 前注入（保证进化总结符合行为准则）

## 2.2 固定注入顺序

1. `GENE`（最高优先级）
2. `AGENTS`
3. `TOOLS`
4. `memory_context`
5. `capability_context`（已批准能力 Top-K）

## 2.3 Prompt Block 规范

```text
<policy_gene>...</policy_gene>
<policy_agents>...</policy_agents>
<policy_tools>...</policy_tools>
<memory_context>...</memory_context>
<capability_context>...</capability_context>
```

禁止把策略文档内容散落拼接到自由文本段，避免优先级失效与冲突覆盖。

## 3. Token 预算与裁剪

1. `GENE`：不截断，只允许“精简版 + 完整版”切换。
2. `AGENTS`：按章节优先级裁剪（核心流程 > 扩展流程）。
3. `TOOLS`：按工具相关性裁剪（本次计划涉及工具优先）。
4. `capability_context`：按相关度 Top-K。

推荐默认预算（可配置）：

1. `GENE`: 400-800 tokens
2. `AGENTS`: 600-1200 tokens
3. `TOOLS`: 800-1600 tokens
4. `memory + capability`: 动态预算

## 4. 版本治理与发布策略

## 4.1 文档表模型（建议）

`context_policy_docs`

1. `doc_type`: `gene | agents | tools`
2. `version`: 语义版本或递增版本
3. `status`: `draft | review_required | approved | archived`
4. `content`: Markdown 正文
5. `source_candidate_id`: 来源能力候选（可空）
6. `last_reviewed_by`, `last_reviewed_at`

## 4.2 更新策略

1. `GENE.md`
   - `manual_only`
   - 仅允许产生建议补丁，不自动合并
2. `AGENTS.md`
   - `manual_required`
   - 可自动提议，需人审
3. `TOOLS.md`
   - `auto_propose + human_approve`
   - 默认人审，后续可对低风险条目开启自动合并

## 4.3 回滚策略

1. 任一文档更新后出现异常指标（成功率下降、违规率上升）可一键回退到上一版本。
2. 回滚事件统一写审计：`context.policy.rolled_back`。

## 5. 与进化系统的对接

1. Learning 捕获到高价值模式后，先生成 `policy_patch_candidate`。
2. Patch Candidate 经过安全与一致性检查后进入审批。
3. 审批通过后更新对应文档版本，并触发：
   - `context.policy.updated`
   - `context.injection.cache.invalidated`

## 6. 一致性校验（运行时）

注入前执行 3 类校验：

1. `gene_alignment_check`
   - 候选能力是否违反行为边界与风险偏好
2. `agent_flow_check`
   - 执行流程是否与协作规范冲突
3. `tool_policy_check`
   - 工具调用是否违反参数/权限/安全规则

任一校验失败时：

1. 计划生成降级（移除违规能力）
2. 写审计事件
3. 在审批中心显示冲突条目

## 7. 迁移建议

## 7.1 文件迁移

1. 若历史有文件版 `SOUL.md/GENE.md/AGENTS.md/TOOLS.md`，一次性导入数据库。
2. 导入后以数据库为准；文件仅可选导出，不再参与 runtime 注入。

## 7.2 代码迁移

1. 引入统一注入器 `ContextPolicyInjector`。
2. 在 planner/respond/reflect 节点统一调用，不再各处散拼。
3. snapshot 中输出文档版本信息：`gene_version/agents_version/tools_version`。

## 7.3 API 迁移与废弃声明

1. 旧接口 `/api/v1/context-policies` 标记为 `deprecated`（仅兼容保留）。
2. 响应头返回迁移提示：
   - `Deprecation: true`
   - `Sunset: Tue, 30 Jun 2026 00:00:00 GMT`
   - `Link: </api/v1/evolution-capabilities>; rel="successor-version"`
3. 新实现统一走 `/api/v1/evolution-capabilities`（`hands/reflex/spine/guard/mind`）。

## 8. 验收标准

1. 任一请求可在 runtime 日志中看到注入版本与来源。
2. `GENE` 规则在 PLAN 与 RESPOND 两个节点都可观测到生效。
3. 文档更新可追溯到候选、审批、发布、回滚全过程。
4. 切换文档版本后 1 分钟内可在新请求中生效。

## 9. 关联文档

1. [进化机制（V2 重设计）](./evolution-context-system.md)
2. [进化流水线（现版）](./evolution-pipeline.md)
3. [事件框架总览](./event-framework.md)

## 10. 实施清单（注入侧）

### 10.1 数据表 DDL（建议）

```sql
CREATE TABLE IF NOT EXISTS context_policy_docs (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  doc_type TEXT NOT NULL,            -- gene|agents|tools
  version TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'approved',
  content TEXT NOT NULL,
  source_candidate_id TEXT,
  last_reviewed_by TEXT,
  last_reviewed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(org_id, doc_type, version)
);

CREATE TABLE IF NOT EXISTS context_policy_patch_candidates (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  doc_type TEXT NOT NULL,
  target_version TEXT NOT NULL,
  patch_unified_diff TEXT NOT NULL,
  rationale TEXT,
  source_learning_ids_json TEXT NOT NULL DEFAULT '[]',
  source_capability_id TEXT,
  risk_level TEXT NOT NULL DEFAULT 'medium',
  status TEXT NOT NULL DEFAULT 'review_required',
  created_by TEXT,
  reviewed_by TEXT,
  reviewed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

### 10.2 Runtime 注入器接口（建议）

```python
class ContextPolicyInjector(Protocol):
    async def load_policy_bundle(self, org_id: str, agent_id: str) -> dict[str, str]:
        ...

    async def build_injection_blocks(
        self,
        org_id: str,
        agent_id: str,
        user_query: str,
        memory_context: str,
        capability_context: str,
        token_budget: int,
    ) -> str:
        ...
```

接线点：

1. `plan_node` 调用注入器后再生成计划
2. `respond_node` 调用注入器后再生成回复
3. `reflect_node` 调用注入器后再反思

### 10.3 事件与缓存刷新

最小事件：

1. `context.policy.updated`
2. `context.policy.rolled_back`
3. `context.injection.cache.invalidated`

`context.policy.updated` 触发后必须：

1. 失效注入缓存（按 `org_id + agent_id`）
2. 在下一个请求生效新版本

### 10.4 审批中心 UI 字段（策略补丁）

列表页：

1. 对象类型（policy_patch）
2. 文档类型（gene/agents/tools）
3. 目标版本（target_version）
4. 风险等级
5. 创建时间
6. 状态（review_required/approved/rejected/applied）

详情页：

1. Unified Diff 视图
2. 变更原因（rationale）
3. 来源证据（learning/capability）
4. 冲突校验结果（gene_alignment/agent_flow/tool_policy）

操作：

1. 批准并应用
2. 拒绝（必填原因）
3. 回滚到上一版本
