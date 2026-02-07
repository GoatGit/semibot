# 任务：将 Mock 会话调整为真实 Agent 对话

## 状态
- [x] 已完成

## 优先级
高

## 描述
当前前端会话使用的是 mock 数据，需要调整为调用真实的 Agent API 进行对话交互。

## 目标
- [x] 移除前端 mock 会话数据和逻辑
- [x] 对接真实的 Agent 对话 API
- [x] 实现 SSE 流式响应展示
- [x] 保持现有 UI 交互体验

## 完成情况
- 已实现 `useChat` Hook，封装了 SSE 连接 (`useSSE`) 和消息状态管理 (`useAgent2UI`)
- `ChatSessionPage` (`chat/[sessionId]`) 已接入真实 API，支持流式响应、思考过程展示、工具调用状态
- `ChatPage` (`chat/`) 已接入真实 API，支持会话列表加载、删除
- `NewChatPage` (`chat/new`) 已接入真实 API，支持加载 Agent 列表、创建新会话
- 移除了所有 Mock 数据和模拟延迟逻辑


## 涉及模块
- `apps/web` - 前端会话页面
- `apps/app` - 后端 Agent API
- `packages/runtime` - Agent 运行时

## 技术要点
- 替换 mock 数据为真实 API 调用
- 处理 SSE 流式响应
- 错误处理和重连机制
- 会话状态管理

## 相关任务
- `frontend-real-api-sse-integration.md`
- `app-chat-service-implementation.md`

## 创建时间
2024-02-07
