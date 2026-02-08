## Task: Chat 主流程切换到 Runtime（灰度可回滚）

**ID:** chat-cutover-to-runtime  
**Label:** Semibot: Chat 切 Runtime 主链  
**Description:** 将 API chat 执行链从 direct LLM 切换到 runtime orchestrator，并保留灰度回退能力  
**Type:** Core Architecture  
**Status:** Backlog  
**Priority:** P0 - Critical  
**Created:** 2026-02-08  
**Updated:** 2026-02-08  
**PRD:** `chat-cutover-to-runtime.md`

---

### 阶段 A：适配层建设

- [ ] 在 API 新增 runtime adapter（state 输入与事件输出映射）
- [ ] 增加 execution mode 开关（direct/runtime）
- [ ] 增加 runtime 超时与错误回退逻辑

### 阶段 B：事件协议与前端兼容

- [ ] 补齐 `plan_step/skill_call/tool_call/mcp_call` 事件模型
- [ ] 保持旧事件兼容（message/error/done）
- [ ] 前端按事件类型分组展示调用链

### 阶段 C：灰度与回退

- [ ] 支持 org 白名单灰度
- [ ] 支持 shadow 模式对比 direct/runtime
- [ ] 增加自动回退触发条件（错误率/超时率阈值）

### 阶段 D：观测与运维

- [ ] 增加 runtime trace 存储与查询
- [ ] 增加关键 dashboard（成功率、时延、回退率）
- [ ] 增加值班 runbook（故障定位与回滚流程）

### 阶段 E：测试与发布

- [ ] API 集成测试：runtime 模式下完整 SSE 流
- [ ] 回归测试：direct 模式行为不变
- [ ] 压测：runtime 模式性能基线
- [ ] 发布评审：灰度策略与回退策略确认

---

### 验收标准

- [ ] chat 默认可切换至 runtime，且稳定运行
- [ ] 发生异常可在分钟级回退 direct 模式
- [ ] 前端能展示完整执行链与错误位置
- [ ] 发布后有可观测指标支持持续优化
