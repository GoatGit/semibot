# Execution Plane 架构设计复审报告（第四轮）

- 日期：2026-02-21
- 范围：`docs/design/execution-plane-arch/`
- 结论：~~第三轮阻断问题基本已收敛；剩余 4 个问题（1 高 + 3 中低）建议在实现前统一。~~ **全部 4 个问题已修复。**

## 主要问题（按严重度）

### 1) [高] ~~`ticket` 仅作为"首次连接"约束，但当前服务端逻辑未区分首连与重连~~ ✅ 已修复

现状：
- 文档声明：首次连接需要 `ticket`，重连可不带 `ticket`。
  `docs/design/execution-plane-arch/03-CONTROL-PLANE.md:116`
  `docs/design/execution-plane-arch/05-WEBSOCKET-PROTOCOL.md:21`
- 认证示例实现：`ticket` 为空直接放行到下一阶段（仅靠 `auth` JWT），未判断是否"重连场景"。
  `docs/design/execution-plane-arch/03-CONTROL-PLANE.md:125`
  `docs/design/execution-plane-arch/03-CONTROL-PLANE.md:129`

影响：
- 任何持有有效 VM JWT 的连接都可绕过 ticket 阶段；ticket 的"首次连接门禁"语义无法成立。

**决策：仅靠 JWT 有效性判定合法性。** ticket 作为首次连接的额外校验层，不是安全边界。无 ticket 时安全保障完全依赖首帧 auth 消息中的 JWT 验证（JWT 有效 + user_id 匹配 + 存在活跃 VM 实例）。已更新 `03-CONTROL-PLANE.md` 认证代码注释。

### 2) [中] ~~`default_vm_mode` / `vm_mode` 命名在文档间仍不一致~~ ✅ 已修复

现状：
- 迁移总览写 `org.vm_mode`。
  `docs/design/execution-plane-arch/06-MIGRATION-PLAN.md:40`
- 迁移 SQL 用 `organizations.default_vm_mode`。
  `docs/design/execution-plane-arch/06-MIGRATION-PLAN.md:561`
- 控制平面 SQL 也用 `organizations.default_vm_mode`。
  `docs/design/execution-plane-arch/03-CONTROL-PLANE.md:881`

**决策：组织级统一为 `default_vm_mode`。** 已修复 `06-MIGRATION-PLAN.md` 中 `org.vm_mode` → `org.default_vm_mode`。

### 3) [中] ~~`default_vm_mode` 默认值跨文档冲突（`firecracker` vs `docker`）~~ ✅ 已修复

现状：
- 控制平面文档默认 `firecracker`。
  `docs/design/execution-plane-arch/03-CONTROL-PLANE.md:881`
- 迁移计划默认 `docker`。
  `docs/design/execution-plane-arch/06-MIGRATION-PLAN.md:561`

**决策：统一默认 `docker`。** 已修复 `03-CONTROL-PLANE.md` 中 organizations 和 agents 表的 `DEFAULT 'firecracker'` → `DEFAULT 'docker'`。

### 4) [低] ~~重连流程编号有笔误（4/5 重复）~~ ✅ 已修复

现状：
- 步骤编号出现 `...3,4,5,4,5...`。
  `docs/design/execution-plane-arch/05-WEBSOCKET-PROTOCOL.md:387`

**已修复：** 重新编号为连续 1..11。

## 本轮确认已修复（前序轮次遗留）

1. 重连不再复用一次性 ticket，客户端已区分 `connect_url` 和 `reconnect_url`。
   `docs/design/execution-plane-arch/04-EXECUTION-PLANE.md:116`
   `docs/design/execution-plane-arch/04-EXECUTION-PLANE.md:174`
2. 协议已将 `auth` 纳入无 `session_id` 例外列表。
   `docs/design/execution-plane-arch/05-WEBSOCKET-PROTOCOL.md:74`
3. `status` 枚举已包含 `failed`，与唯一索引条件一致。
   `docs/design/execution-plane-arch/06-MIGRATION-PLAN.md:483`
   `docs/design/execution-plane-arch/06-MIGRATION-PLAN.md:578`
4. 旧术语 `legacy` 已在关键回滚/前置条件处替换为 `routing_mode='http'`。
   `docs/design/execution-plane-arch/06-MIGRATION-PLAN.md:434`

## 确认结果

1. ~~你希望"无 ticket 连接"在什么条件下被视为合法重连？~~ → **仅靠 JWT 有效性**
2. ~~组织级 VM 模式最终字段名用 `default_vm_mode` 还是 `vm_mode`？~~ → **`default_vm_mode`**
3. ~~组织/Agent 的默认 VM 模式最终基线是 `docker` 还是 `firecracker`？~~ → **`docker`**
