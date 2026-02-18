# PRD: Playwright 浏览器自动化工具

## 背景

AGENT_RUNTIME.md 明确要求浏览器自动化能力（Playwright + 语义快照），使 Agent 能够浏览网页、填写表单、截图、提取内容。当前 Runtime 仅有 `web_search.py`（搜索工具），完全缺少浏览器自动化能力。

## 功能需求

### 1. 网页导航与交互

- 打开 URL、前进/后退/刷新
- 点击元素（支持 CSS 选择器和文本匹配）
- 填写表单（input、textarea、select）
- 等待条件（元素出现、页面加载、网络空闲）

### 2. 内容提取

- 截图（全页面或指定区域）
- 提取页面文本内容
- 提取结构化数据（表格、列表）
- 语义快照：将页面 DOM 简化为 LLM 可理解的结构化描述

### 3. 安全控制

- URL 白名单/黑名单
- 禁止访问内网地址（127.0.0.1、10.x、172.16-31.x、192.168.x）
- 单次会话超时限制（60s）
- 浏览器实例池管理（最大并发数限制）
- 禁止文件下载到宿主机

### 4. 资源管理

- 浏览器实例池（预热 + 按需创建）
- 空闲实例自动回收
- 内存使用监控

## 技术方案

### 工具定义

```python
# runtime/src/skills/browser_tool.py

class BrowserTool:
    """Playwright 浏览器自动化工具"""

    async def navigate(self, url: str) -> dict:
        """导航到指定 URL，返回页面标题和语义快照"""

    async def click(self, selector: str) -> dict:
        """点击页面元素"""

    async def fill(self, selector: str, value: str) -> dict:
        """填写表单字段"""

    async def screenshot(self, full_page: bool = False) -> dict:
        """截图，返回 base64 图片"""

    async def extract_text(self) -> dict:
        """提取页面文本内容"""

    async def extract_table(self, selector: str) -> dict:
        """提取表格数据为结构化 JSON"""

    async def semantic_snapshot(self) -> dict:
        """生成页面语义快照（简化 DOM 描述）"""
```

### 语义快照格式

```json
{
  "title": "页面标题",
  "url": "https://example.com",
  "main_content": "页面主要文本内容（截断到 2000 字）",
  "links": [{"text": "链接文本", "href": "URL"}],
  "forms": [{"action": "URL", "fields": [{"name": "字段名", "type": "text"}]}],
  "tables": [{"headers": ["列1", "列2"], "row_count": 10}]
}
```

### 涉及文件

- 新增 `runtime/src/skills/browser_tool.py`
- 新增 `runtime/src/skills/browser_pool.py` — 浏览器实例池
- 修改 `runtime/src/skills/__init__.py` — 注册工具
- 修改 `runtime/pyproject.toml` — 添加 playwright 依赖

## 优先级

**P1 — 设计文档已规划，Agent 能力的重要扩展**

## 验收标准

- [ ] 网页导航和交互功能正常
- [ ] 截图功能正常（全页面/区域）
- [ ] 语义快照生成正确
- [ ] 内网地址访问被拦截
- [ ] 超时控制生效
- [ ] 浏览器实例池管理正常
- [ ] 安全测试通过
- [ ] 单元测试覆盖核心逻辑
