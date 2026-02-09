# 任务：Executor 职责明确

**优先级**: 🟢 P2 - 中优先级
**类型**: 代码质量
**预估工时**: 2-3 小时
**影响范围**: runtime/src/executor/

---

## 问题描述

Executor 模块职责边界不清晰：
1. 同时包含 Agent 执行和 Node 执行逻辑
2. 功能重叠，难以维护
3. 测试困难

---

## 当前结构

```
runtime/src/executor/
├── agent_executor.py    # Agent 执行器
├── node_executor.py     # Node 执行器
├── base.py              # 基类（职责不清）
└── utils.py             # 工具函数
```

---

## 问题分析

### 1. 职责重叠

```python
# agent_executor.py
class AgentExecutor:
    async def execute(self, input: str) -> str:
        # 处理输入
        # 调用 LLM
        # 执行工具
        # 返回结果
        pass

# node_executor.py
class NodeExecutor:
    async def execute(self, input: str) -> str:
        # 类似的逻辑
        # 调用 LLM
        # 执行工具
        pass
```

### 2. 依赖混乱

```python
# agent_executor.py
from .node_executor import NodeExecutor  # 循环依赖风险

# node_executor.py
from .agent_executor import AgentExecutor  # 循环依赖
```

---

## 修复方案

### 1. 重新定义职责

| 组件 | 职责 | 依赖 |
|------|------|------|
| `BaseExecutor` | 定义执行接口 | 无 |
| `AgentExecutor` | 执行 Agent 任务 | LLMProvider, ToolRunner |
| `NodeExecutor` | 执行 LangGraph Node | AgentExecutor（可选） |
| `ToolRunner` | 执行工具调用 | MCP Client |
| `LLMProvider` | LLM 调用抽象 | 各 LLM SDK |

### 2. 重构后结构

```
runtime/src/executor/
├── __init__.py
├── base.py              # 抽象基类
├── agent/
│   ├── __init__.py
│   ├── executor.py      # Agent 执行器
│   └── context.py       # 执行上下文
├── node/
│   ├── __init__.py
│   ├── executor.py      # Node 执行器
│   └── state.py         # 状态管理
├── tool/
│   ├── __init__.py
│   ├── runner.py        # 工具运行器
│   └── registry.py      # 工具注册
└── utils/
    ├── __init__.py
    └── helpers.py       # 通用工具
```

### 3. 抽象基类

```python
# runtime/src/executor/base.py

from abc import ABC, abstractmethod
from typing import Any, Dict, Generic, TypeVar

InputT = TypeVar('InputT')
OutputT = TypeVar('OutputT')


class BaseExecutor(ABC, Generic[InputT, OutputT]):
    """执行器抽象基类"""

    @abstractmethod
    async def execute(self, input: InputT) -> OutputT:
        """执行任务"""
        pass

    @abstractmethod
    async def validate_input(self, input: InputT) -> bool:
        """验证输入"""
        pass

    async def pre_execute(self, input: InputT) -> None:
        """执行前钩子"""
        pass

    async def post_execute(self, output: OutputT) -> None:
        """执行后钩子"""
        pass

    async def run(self, input: InputT) -> OutputT:
        """完整执行流程"""
        if not await self.validate_input(input):
            raise ValueError("Invalid input")

        await self.pre_execute(input)
        output = await self.execute(input)
        await self.post_execute(output)

        return output
```

### 4. Agent 执行器

```python
# runtime/src/executor/agent/executor.py

from typing import List, Optional
from ..base import BaseExecutor
from ..tool.runner import ToolRunner
from ...llm.provider import LLMProvider
from ...utils.logging import get_logger

logger = get_logger(__name__)


class AgentInput:
    """Agent 执行输入"""
    def __init__(
        self,
        message: str,
        session_id: str,
        agent_id: str,
        context: Optional[dict] = None
    ):
        self.message = message
        self.session_id = session_id
        self.agent_id = agent_id
        self.context = context or {}


class AgentOutput:
    """Agent 执行输出"""
    def __init__(
        self,
        response: str,
        tool_calls: List[dict],
        tokens_used: int
    ):
        self.response = response
        self.tool_calls = tool_calls
        self.tokens_used = tokens_used


class AgentExecutor(BaseExecutor[AgentInput, AgentOutput]):
    """Agent 执行器"""

    def __init__(
        self,
        llm_provider: LLMProvider,
        tool_runner: ToolRunner
    ):
        self.llm_provider = llm_provider
        self.tool_runner = tool_runner

    async def validate_input(self, input: AgentInput) -> bool:
        """验证输入"""
        if not input.message or not input.message.strip():
            return False
        if not input.session_id or not input.agent_id:
            return False
        return True

    async def execute(self, input: AgentInput) -> AgentOutput:
        """执行 Agent 任务"""
        logger.info(
            "Executing agent task",
            extra={
                "session_id": input.session_id,
                "agent_id": input.agent_id
            }
        )

        # 1. 构建消息
        messages = self._build_messages(input)

        # 2. 调用 LLM
        llm_response = await self.llm_provider.chat(messages)

        # 3. 处理工具调用
        tool_calls = []
        if llm_response.tool_calls:
            tool_calls = await self._process_tool_calls(llm_response.tool_calls)

        # 4. 返回结果
        return AgentOutput(
            response=llm_response.content,
            tool_calls=tool_calls,
            tokens_used=llm_response.tokens_used
        )

    def _build_messages(self, input: AgentInput) -> List[dict]:
        """构建消息列表"""
        # 实现消息构建逻辑
        pass

    async def _process_tool_calls(self, tool_calls: List[dict]) -> List[dict]:
        """处理工具调用"""
        results = []
        for call in tool_calls:
            result = await self.tool_runner.run(
                tool_name=call["name"],
                arguments=call["arguments"]
            )
            results.append({
                "tool_call_id": call["id"],
                "name": call["name"],
                "result": result
            })
        return results
```

### 5. 工具运行器

```python
# runtime/src/executor/tool/runner.py

from typing import Any, Dict
from ...mcp.client import MCPClient
from ...utils.logging import get_logger

logger = get_logger(__name__)


class ToolRunner:
    """工具运行器"""

    def __init__(self, mcp_client: MCPClient):
        self.mcp_client = mcp_client
        self._tools: Dict[str, Any] = {}

    async def run(self, tool_name: str, arguments: Dict[str, Any]) -> Any:
        """运行工具"""
        logger.info(f"Running tool: {tool_name}", extra={"arguments": arguments})

        # 查找工具
        tool = self._tools.get(tool_name)
        if not tool:
            # 尝试从 MCP 获取
            tool = await self._get_from_mcp(tool_name)

        if not tool:
            raise ValueError(f"Tool not found: {tool_name}")

        # 执行工具
        try:
            result = await tool.execute(arguments)
            logger.info(f"Tool execution complete: {tool_name}")
            return result
        except Exception as e:
            logger.error(f"Tool execution failed: {tool_name}", exc_info=True)
            raise

    async def _get_from_mcp(self, tool_name: str) -> Any:
        """从 MCP 获取工具"""
        # 实现 MCP 工具获取逻辑
        pass

    def register(self, name: str, tool: Any) -> None:
        """注册工具"""
        self._tools[name] = tool

    def unregister(self, name: str) -> None:
        """注销工具"""
        self._tools.pop(name, None)
```

---

## 修复清单

### 重构结构
- [ ] 创建 `executor/agent/` 目录
- [ ] 创建 `executor/node/` 目录
- [ ] 创建 `executor/tool/` 目录

### 实现组件
- [ ] 实现 `BaseExecutor` 抽象类
- [ ] 实现 `AgentExecutor`
- [ ] 实现 `NodeExecutor`
- [ ] 实现 `ToolRunner`

### 更新引用
- [ ] 更新所有 import 路径
- [ ] 更新依赖注入

### 测试
- [ ] 为每个组件添加测试
- [ ] 确保功能不变

---

## 完成标准

- [ ] 职责边界清晰
- [ ] 无循环依赖
- [ ] 测试覆盖完整
- [ ] 代码审查通过

---

## 相关文档

- [架构设计](docs/design/ARCHITECTURE.md)
- [Runtime 模块](docs/design/RUNTIME.md)
