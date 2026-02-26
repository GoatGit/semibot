# 技能进化事件流水线（详细设计）

> 目标：将技能进化纳入事件框架，形成可审计、可回放的闭环。

## 1. 触发事件

- `task.completed`
- `tool.exec.completed`
- `user.feedback.positive`

## 2. 流水线阶段

1. **候选生成**：从成功执行中抽取可复用步骤  
2. **质量评分**：评估稳定性、成本、成功率  
3. **去重合并**：与现有技能语义去重  
4. **审批发布**：高风险技能需人工审核  
5. **索引发布**：写入 SQLite + 向量索引  

## 3. 事件类型

- `evolution.candidate.created`
- `evolution.candidate.scored`
- `evolution.review.requested`
- `evolution.skill.approved`
- `evolution.skill.rejected`

## 4. 规则建议

- 只对连续成功次数超过阈值的任务生成候选  
- 低质量候选自动丢弃并写审计  
- 被拒绝的候选进入冷却期
