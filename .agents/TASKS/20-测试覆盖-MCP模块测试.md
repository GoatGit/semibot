# 任务：MCP 模块测试

**优先级**: 🟡 P1 - 高优先级
**类型**: 测试覆盖
**预估工时**: 2-3 天
**影响范围**: runtime/src/mcp/ 目录

---

## 问题描述

MCP（Model Context Protocol）模块负责与外部工具服务通信，是系统的核心基础设施，但**缺少完整的测试覆盖**。

---

## 需要测试的文件

| 文件 | 功能 | 测试重点 |
|------|------|----------|
| `client.py` | MCP 客户端 | 连接管理、并发安全 |
| `manager.py` | MCP 管理器 | 服务发现、负载均衡 |
| `registry.py` | 服务注册 | 注册/注销、健康检查 |
| `protocol.py` | 协议实现 | 消息序列化、错误处理 |

---

## 测试用例

### 1. MCPClient 测试

```python
# runtime/tests/mcp/test_client.py

import pytest
import asyncio
from unittest.mock import AsyncMock, patch, MagicMock
from src.mcp.client import MCPClient, ConnectionStatus


class TestMCPClient:
    """MCPClient 单元测试"""

    @pytest.fixture
    def client(self):
        return MCPClient()

    # ============================================================
    # 连接管理测试
    # ============================================================

    @pytest.mark.asyncio
    async def test_connect_success(self, client):
        """测试成功连接"""
        with patch.object(client, '_create_connection', new_callable=AsyncMock) as mock:
            mock.return_value = MagicMock()

            result = await client.connect("server-1", {"url": "http://localhost:8080"})

            assert result is True
            assert client.get_status("server-1") == ConnectionStatus.CONNECTED

    @pytest.mark.asyncio
    async def test_connect_failure(self, client):
        """测试连接失败"""
        with patch.object(client, '_create_connection', new_callable=AsyncMock) as mock:
            mock.side_effect = Exception("Connection refused")

            with pytest.raises(Exception):
                await client.connect("server-1", {"url": "http://localhost:8080"})

            assert client.get_status("server-1") == ConnectionStatus.ERROR

    @pytest.mark.asyncio
    async def test_connect_duplicate(self, client):
        """测试重复连接"""
        with patch.object(client, '_create_connection', new_callable=AsyncMock) as mock:
            mock.return_value = MagicMock()

            await client.connect("server-1", {"url": "http://localhost:8080"})
            result = await client.connect("server-1", {"url": "http://localhost:8080"})

            assert result is True
            assert mock.call_count == 1  # 只调用一次

    # ============================================================
    # 断开连接测试
    # ============================================================

    @pytest.mark.asyncio
    async def test_disconnect_success(self, client):
        """测试成功断开连接"""
        mock_conn = AsyncMock()
        client._connections["server-1"] = mock_conn
        client._servers["server-1"] = {}
        client._connection_status["server-1"] = ConnectionStatus.CONNECTED

        result = await client.disconnect("server-1")

        assert result is True
        assert "server-1" not in client._connections
        mock_conn.close.assert_called_once()

    @pytest.mark.asyncio
    async def test_disconnect_not_connected(self, client):
        """测试断开未连接的服务器"""
        result = await client.disconnect("non-existent")

        assert result is False

    # ============================================================
    # close_all 测试
    # ============================================================

    @pytest.mark.asyncio
    async def test_close_all_clears_all_resources(self, client):
        """测试 close_all 清理所有资源"""
        # 模拟多个连接
        for i in range(3):
            client._servers[f"server-{i}"] = {}
            client._connections[f"server-{i}"] = AsyncMock()
            client._connection_status[f"server-{i}"] = ConnectionStatus.CONNECTED

        await client.close_all()

        assert len(client._servers) == 0
        assert len(client._connections) == 0
        assert len(client._connection_status) == 0

    @pytest.mark.asyncio
    async def test_close_all_handles_errors(self, client):
        """测试 close_all 处理错误"""
        mock_conn = AsyncMock()
        mock_conn.close.side_effect = Exception("Close error")

        client._servers["server-1"] = {}
        client._connections["server-1"] = mock_conn
        client._connection_status["server-1"] = ConnectionStatus.CONNECTED

        # 不应抛出异常
        await client.close_all()

        # 资源仍然被清理
        assert len(client._servers) == 0

    @pytest.mark.asyncio
    async def test_close_all_concurrent_safe(self, client):
        """测试 close_all 并发安全"""
        for i in range(5):
            client._servers[f"server-{i}"] = {}
            client._connections[f"server-{i}"] = AsyncMock()
            client._connection_status[f"server-{i}"] = ConnectionStatus.CONNECTED

        # 并发调用
        await asyncio.gather(
            client.close_all(),
            client.close_all()
        )

        assert len(client._servers) == 0

    # ============================================================
    # 状态查询测试
    # ============================================================

    def test_get_status_existing(self, client):
        """测试获取已存在服务器状态"""
        client._connection_status["server-1"] = ConnectionStatus.CONNECTED

        result = client.get_status("server-1")

        assert result == ConnectionStatus.CONNECTED

    def test_get_status_not_exists(self, client):
        """测试获取不存在服务器状态"""
        result = client.get_status("non-existent")

        assert result is None

    def test_get_all_statuses(self, client):
        """测试获取所有状态"""
        client._connection_status = {
            "server-1": ConnectionStatus.CONNECTED,
            "server-2": ConnectionStatus.DISCONNECTED
        }

        result = client.get_all_statuses()

        assert len(result) == 2
        assert result["server-1"] == ConnectionStatus.CONNECTED

    def test_connected_count(self, client):
        """测试已连接数量统计"""
        client._connection_status = {
            "server-1": ConnectionStatus.CONNECTED,
            "server-2": ConnectionStatus.DISCONNECTED,
            "server-3": ConnectionStatus.CONNECTED
        }

        assert client.connected_count == 2
```

### 2. MCPManager 测试

```python
# runtime/tests/mcp/test_manager.py

import pytest
from unittest.mock import AsyncMock, MagicMock, patch
from src.mcp.manager import MCPManager


class TestMCPManager:
    """MCPManager 单元测试"""

    @pytest.fixture
    def manager(self):
        return MCPManager()

    @pytest.mark.asyncio
    async def test_register_server(self, manager):
        """测试注册服务器"""
        config = {
            "name": "test-server",
            "url": "http://localhost:8080",
            "tools": ["tool1", "tool2"]
        }

        result = await manager.register_server("server-1", config)

        assert result is True
        assert "server-1" in manager.servers

    @pytest.mark.asyncio
    async def test_unregister_server(self, manager):
        """测试注销服务器"""
        manager.servers["server-1"] = {"name": "test"}

        result = await manager.unregister_server("server-1")

        assert result is True
        assert "server-1" not in manager.servers

    @pytest.mark.asyncio
    async def test_get_server_for_tool(self, manager):
        """测试根据工具获取服务器"""
        manager.servers = {
            "server-1": {"tools": ["tool1", "tool2"]},
            "server-2": {"tools": ["tool3"]}
        }

        result = await manager.get_server_for_tool("tool1")

        assert result == "server-1"

    @pytest.mark.asyncio
    async def test_get_server_for_unknown_tool(self, manager):
        """测试获取未知工具的服务器"""
        manager.servers = {}

        result = await manager.get_server_for_tool("unknown")

        assert result is None

    @pytest.mark.asyncio
    async def test_health_check(self, manager):
        """测试健康检查"""
        with patch.object(manager, '_ping_server', new_callable=AsyncMock) as mock:
            mock.return_value = True
            manager.servers = {"server-1": {}}

            result = await manager.health_check("server-1")

            assert result is True
            mock.assert_called_once_with("server-1")
```

### 3. 集成测试

```python
# runtime/tests/mcp/test_integration.py

import pytest
import asyncio
from src.mcp.client import MCPClient
from src.mcp.manager import MCPManager


class TestMCPIntegration:
    """MCP 模块集成测试"""

    @pytest.fixture
    async def setup(self):
        """设置测试环境"""
        client = MCPClient()
        manager = MCPManager()
        yield client, manager
        await client.close_all()

    @pytest.mark.asyncio
    async def test_full_lifecycle(self, setup):
        """测试完整生命周期"""
        client, manager = setup

        # 1. 注册服务器
        config = {"url": "http://localhost:8080", "tools": ["calc"]}
        await manager.register_server("math-server", config)

        # 2. 连接
        # 注意：实际测试需要 Mock 或测试服务器

        # 3. 使用

        # 4. 断开

        # 5. 注销
        await manager.unregister_server("math-server")

        assert "math-server" not in manager.servers

    @pytest.mark.asyncio
    async def test_reconnection(self, setup):
        """测试重连机制"""
        client, _ = setup

        # 模拟断开后重连
        # ...

    @pytest.mark.asyncio
    async def test_load_balancing(self, setup):
        """测试负载均衡"""
        _, manager = setup

        # 注册多个相同工具的服务器
        await manager.register_server("server-1", {"tools": ["tool1"]})
        await manager.register_server("server-2", {"tools": ["tool1"]})

        # 验证负载均衡
        results = []
        for _ in range(10):
            server = await manager.get_server_for_tool("tool1")
            results.append(server)

        # 应该有分布
        assert "server-1" in results or "server-2" in results
```

---

## 测试目录结构

```
runtime/tests/mcp/
├── __init__.py
├── conftest.py              # 共享 fixtures
├── test_client.py           # MCPClient 测试
├── test_manager.py          # MCPManager 测试
├── test_registry.py         # Registry 测试
├── test_protocol.py         # Protocol 测试
└── test_integration.py      # 集成测试
```

---

## 修复清单

### 测试文件
- [ ] 创建 `tests/mcp/conftest.py`
- [ ] 创建 `tests/mcp/test_client.py`
- [ ] 创建 `tests/mcp/test_manager.py`
- [ ] 创建 `tests/mcp/test_registry.py`
- [ ] 创建 `tests/mcp/test_protocol.py`
- [ ] 创建 `tests/mcp/test_integration.py`

### 覆盖目标
- [ ] `client.py` 覆盖率 >= 80%
- [ ] `manager.py` 覆盖率 >= 80%
- [ ] `registry.py` 覆盖率 >= 80%
- [ ] `protocol.py` 覆盖率 >= 80%

---

## 完成标准

- [ ] 所有 MCP 模块有测试
- [ ] 测试覆盖率 >= 80%
- [ ] 集成测试通过
- [ ] CI 集成通过
- [ ] 代码审查通过

---

## 相关文档

- [测试规范](docs/design/TESTING.md)
- [MCP 协议文档](docs/design/MCP.md)
