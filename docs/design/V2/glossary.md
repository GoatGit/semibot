# 术语表

## 核心术语

- `Event Engine`：事件接入、规则匹配、治理和路由层
- `Orchestrator`：复杂任务编排层（LangGraph）
- `Tools`：稳定可直接调用的内置工具能力
- `MCP`：外部工具服务接入协议与客户端
- `Skills`：基于 SKILL.md 的任务策略与操作手册
- `HITL`：Human-in-the-Loop，人类审批机制
- `Attention Budget`：主动提醒额度限制
- `Cooldown Window`：同类触发冷却窗口
- `Idempotency Key`：事件幂等唯一键
- `Replay`：按事件重放处理链路

## 事件判定术语

- `skip`：跳过，不执行动作
- `ask`：需要人类审批后再执行
- `suggest`：给建议，不直接执行
- `auto`：自动执行

