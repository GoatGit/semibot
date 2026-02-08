## Task: Runtime 统一执行链（Skills / Agents / MCP）

**ID:** runtime-skills-agents-mcp-flow  
**Label:** Semibot: Runtime 执行链统一  
**Description:** 打通 runtime 的 skills、agent、mcp 执行与观测，确保 planner/act 一致  
**Type:** Architecture Refactor  
**Status:** Backlog  
**Priority:** P0 - Critical  
**Created:** 2026-02-08  
**Updated:** 2026-02-08  
**PRD:** `runtime-skills-agents-mcp-flow.md`

---

### 阶段 A：Bootstrap 上下文注入

- [ ] 定义 `RuntimeSessionContext`（org/user/agent/session）
- [ ] session 启动时加载 agent 绑定技能与 mcp 可用清单
- [ ] 将上下文注入 orchestrator 全节点

### 阶段 B：能力图与 planner 对齐

- [ ] 在 runtime 生成会话级 capability graph
- [ ] planner 仅使用 capability graph 暴露能力
- [ ] 增加校验：planner 产出的 action 必须在 capability graph 内

### 阶段 C：统一执行器

- [ ] ActionExecutor 统一分发 skill/tool/mcp
- [ ] skill 执行增加版本与来源元数据
- [ ] mcp 执行增加状态检查与统一错误映射
- [ ] 高风险调用接入审批钩子

### 阶段 D：观测与审计

- [ ] 增加标准事件：`skill_call/tool_call/mcp_call`
- [ ] 增加标准结果事件：`skill_result/tool_result/mcp_result`
- [ ] 增加 org/session 维度日志字段
- [ ] 统计 runtime 指标（成功率/时延/超时）

### 阶段 E：测试

- [ ] 单测：capability graph 构建与过滤
- [ ] 集成：agent 绑定 skill 后可执行
- [ ] 集成：mcp 断连降级行为
- [ ] 回归：未绑定能力不可执行

---

### 验收标准

- [ ] runtime 执行链不再依赖全局静态 registry
- [ ] planner 与 act 的可执行能力一致
- [ ] skill/tool/mcp 三类执行可统一审计
- [ ] 错误码与事件可被前端稳定消费
