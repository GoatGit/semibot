# Execution Plane 架构设计复审报告（第五轮）

- 日期：2026-02-21
- 范围：`docs/design/execution-plane-arch/`
- 结论：~~阻断级问题已基本清理；剩余为文档一致性与可实现性口径问题（2 中 + 1 低）。~~ **全部 3 个问题已修复。**

## 问题清单

### 1) [中] ~~连接地址定义与重连规则表达不一致~~ ✅ 已修复
- 修复: 连接地址章节拆为两条（首连带 ticket、重连不带），参数表增加说明。`05-WEBSOCKET-PROTOCOL.md:18`

### 2) [中] ~~`ticket` 角色描述仍有歧义（是否硬门禁）~~ ✅ 已修复
- 修复: 在协议文档连接地址章节增加"ticket 定位"说明：ticket 仅用于调度层反滥用，不参与最终认证决策，安全边界完全由 JWT 验证保障。同步更新 `03-CONTROL-PLANE.md` 认证代码注释。

### 3) [低] ~~`vm_mode` 命名在迁移总览文案中仍有轻微混用~~ ✅ 已修复
- 修复: 在"两个独立维度"段落补充完整字段映射表（org.default_vm_mode / user.vm_mode / agent.default_vm_mode）。`06-MIGRATION-PLAN.md:38`

## 本轮确认已修��项

1. 重连流程编号已连续（1-11）。
   `docs/design/execution-plane-arch/05-WEBSOCKET-PROTOCOL.md:385`
2. `status` 枚举与唯一索引条件已一致（包含 `failed`）。
   `docs/design/execution-plane-arch/06-MIGRATION-PLAN.md:483`
   `docs/design/execution-plane-arch/06-MIGRATION-PLAN.md:578`
3. 组织/Agent 默认 VM 模式在 `03` 与 `06` 已统一为 `default_vm_mode`、默认 `docker`。
   `docs/design/execution-plane-arch/03-CONTROL-PLANE.md:887`
   `docs/design/execution-plane-arch/06-MIGRATION-PLAN.md:561`
4. SSE 完成事件命名已统一为 `execution_complete`。
