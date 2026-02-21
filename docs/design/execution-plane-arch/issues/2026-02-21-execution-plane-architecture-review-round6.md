# Execution Plane 架构设计复审报告（第六轮）

- 日期：2026-02-21
- 范围：`docs/design/execution-plane-arch/`
- 结论：~~核心链路已基本稳定；剩余 3 个文档一致性问题。~~ **全部 3 个问题已修复。**

## 发现的问题

### 1) [中] ~~`routing_mode` 优先级描述与字段映射自相矛盾~~ ✅ 已修复
- 修复: 重写字段映射，明确 `routing_mode` 优先级链为 `user > org > system`（不经过 agent），`vm_mode` 优先级链为 `user > agent > org > system`。删除不存在的 `agent.routing_mode`。`06-MIGRATION-PLAN.md:38`

### 2) [中] ~~协议安全说明要求"活跃 VM 实例校验"但示例代码未实现~~ ✅ 已修复
- 修复: 在 `03-CONTROL-PLANE.md` 认证示例中补充 `vmRepo.findActiveByUserId()` 校验步骤，无活跃 VM 时关闭连接（4003）。

### 3) [低] ~~"无 ticket 允许连接"的语义边界模糊~~ ✅ 已修复
- 修复: 统一为"仅限重连场景"，删除"ticket 过期场景"措辞。`03-CONTROL-PLANE.md:130`

## 本轮���认无回归

1. 首连/重连 URL 规则已拆分表达，重连不再依赖一次性 ticket。
2. `execution_complete` 事件命名保持一致。
3. `default_vm_mode` 默认值在 `03` 和 `06` 已一致为 `docker`。
