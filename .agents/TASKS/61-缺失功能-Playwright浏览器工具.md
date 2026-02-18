# TASK-61: Playwright 浏览器自动化工具

## 优先级: P1 — 设计文档已规划，Agent 能力重要扩展

## PRD

[Playwright 浏览器自动化工具](../PRDS/missing-playwright-browser-tool.md)

## 描述

AGENT_RUNTIME.md 明确要求浏览器自动化能力（Playwright + 语义快照）。当前 Runtime 仅有 web_search.py，完全缺少浏览器自动化。

## 涉及文件

- 新增 `runtime/src/skills/browser_tool.py` — 浏览器工具实现
- 新增 `runtime/src/skills/browser_pool.py` — 浏览器实例池
- 修改 `runtime/src/skills/__init__.py` — 注册工具
- 修改 `runtime/pyproject.toml` — 添加 playwright 依赖
- 新增 `runtime/tests/skills/test_browser_tool.py`

## 修复方式

1. 实现 BrowserTool 类：navigate、click、fill、screenshot、extract_text、extract_table、semantic_snapshot
2. 实现 BrowserPool：实例预热、按需创建、空闲回收、并发限制
3. 安全控制：URL 白/黑名单、内网地址拦截、超时控制、禁止文件下载
4. 语义快照：将 DOM 简化为 LLM 可理解的结构化 JSON

## 验收标准

- [ ] 网页导航和交互功能正常
- [ ] 截图功能正常
- [ ] 语义快照生成正确
- [ ] 内网地址访问被拦截
- [ ] 超时控制生效
- [ ] 浏览器实例池管理正常
- [ ] 安全测试通过
- [ ] 单元测试覆盖

## 状态: 待处理
