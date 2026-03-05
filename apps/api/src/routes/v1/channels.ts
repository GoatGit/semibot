/**
 * Channels API 路由
 *
 * V2 命名统一：
 * - 对外统一使用 channels（feishu/telegram/cli/web-ui 等交互通道）
 * - gateway 作为内部连接层概念保留
 * - 该文件复用原 gateways 路由实现，避免破坏现有逻辑
 */

import gatewaysRouter from './gateways'

export default gatewaysRouter

