# Feishu Channel SDK 接入设计（V2）

## 1. 背景与目标

- 现状：Feishu Channel 主要依赖 webhook URL 进行出站通知，能力受限于 webhook 卡片发送。
- 目标：引入飞书官方 Node.js Server SDK，统一通过 SDK 发送消息；保留 webhook 作为兼容兜底。
- 范围：本次先落地 **出站发送链路**（notify/test）；入站事件回调继续走现有 `/v1/integrations/feishu/events`。

官方资料（调研基线）：
- 飞书 Node.js Server SDK 开发准备：https://open.feishu.cn/document/server-side-sdk/nodejs-sdk/preparation-before-development
- 官方 SDK 仓库与示例：https://github.com/larksuite/oapi-sdk-nodejs

## 2. 方案概览

### 2.1 架构

- Runtime `GatewayManager` 增加 `Feishu SDK Send Bridge`：
  - Python 侧负责读取 channel 配置与路由决策
  - Node 脚本负责调用 `@larksuiteoapi/node-sdk` 发送消息
- `FeishuNotifier` 增加双通道发送策略：
  - 优先：SDK（`sdkEnabled=true` 且凭证齐全）
  - 兜底：webhook（`webhookUrl` / `webhookChannels`）

### 2.2 配置模型（Feishu channel.config）

- `sdkEnabled: boolean` 是否启用 SDK 发送
- `appId: string` 飞书应用 App ID
- `appSecret: string` 飞书应用 App Secret（敏感字段，返回掩码）
- `receiveIdType: chat_id|open_id|user_id|union_id|email`
- `defaultReceiveId: string` 默认接收对象 ID（用于 notify）
- `sdkDomain: feishu|lark` 域名选择（国内飞书/国际 Lark）

兼容字段保留：
- `verifyToken`
- `webhookUrl`
- `webhookChannels`

## 3. 发送链路

1. Runtime 触发 notify/test。
2. `GatewayManager.build_feishu_notifier()` 读取 channel config。
3. `FeishuNotifier.send_markdown()` 选择发送策略：
   - SDK ready -> 调用 Node bridge：
     - `runtime/scripts/feishu_sdk_send.mjs`
     - 使用 `client.im.message.create(...)`
   - 否则 fallback webhook。
4. 返回标准发送结果（成功/失败）到上游。

## 4. 前端配置改造

`/config` 的 Feishu Channel 编辑项新增：
- `启用 Feishu Node SDK`
- `App ID`
- `App Secret`（支持清空）
- `receiveIdType`（下拉）
- `defaultReceiveId`
- `sdkDomain`（feishu/lark）

保存时行为：
- 写入 `config.*`（只走 `/channels/*`）
- `clearFields` 支持清理 `appSecret`

## 5. 状态判定

Feishu channel `status=ready` 条件：
- webhook 配置有效，或
- `sdkEnabled=true` 且 `appId+appSecret` 有效。

## 6. 兼容与迁移

- 不破坏旧 webhook 配置。
- 已有 webhook-only 实例无需迁移可继续工作。
- 新建实例建议直接使用 SDK 配置；webhook 可仅用于回调验证。

## 7. 风险与约束

- Runtime 依赖 Node 环境可执行 bridge 脚本。
- 若未安装 `@larksuiteoapi/node-sdk`，SDK 模式发送会失败并可回退 webhook。
- 本期不改入站事件验签模型（后续可再引入 SDK dispatcher 统一化）。

## 8. 实施清单

1. 新增 Node bridge 脚本（SDK 调用）。
2. Runtime notifier/manager 增加 SDK 参数与路由。
3. Config UI 增加 SDK 配置字段。
4. 联调 `/channels/:id/test` 与 `notify` 事件发送。
