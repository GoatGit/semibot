# 前端规范

## Mock 数据清理

Mock 数据必须及时替换为真实 API 调用，禁止 mock 数据写入生产数据库。

---

## SSE 事件标准化

标准事件名：`skill_call`、`skill_result`、`tool_call`、`mcp_call`，前端统一解析。

---

## API Hook 封装

每个 API 模块封装 `useXxx` Hook，内聚 loading/error/data 状态，跨页面复用。

---

## 长操作反馈

安装、同步等长操作通过 SSE 或轮询推送进度，不让用户等待无反馈。
