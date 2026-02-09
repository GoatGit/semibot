# 任务：MCP 资源清理

**优先级**: 🟡 P1 - 高优先级
**类型**: 并发规范
**预估工时**: 1-2 小时
**影响范围**: 1 个文件

---

## 问题描述

`MCP 客户端` 的 `close_all` 方法只关闭了连接，但没有清理内部字典（`_servers`, `_connections`, `_connection_status`），可能导致内存泄漏。

---

## 违规位置

**文件**: `runtime/src/mcp/client.py:287-298`

```python
# ❌ 当前实现 - 资源清理不完整
async def close_all(self) -> None:
    """Close all MCP connections."""
    logger.info("Closing all MCP connections")

    for server_id in list(self._servers.keys()):
        try:
            await self.disconnect(server_id)
        except Exception as e:
            logger.error(
                f"Error disconnecting from server {server_id}: {e}",
                extra={"server_id": server_id},
            )
    # ❌ 缺少字典清理
```

---

## 修复方案

```python
# ✅ 修复后 - 完整的资源清理
async def close_all(self) -> None:
    """Close all MCP connections and clean up resources."""
    logger.info("Closing all MCP connections")

    # 1. 关闭所有连接
    for server_id in list(self._servers.keys()):
        try:
            await self.disconnect(server_id)
        except Exception as e:
            logger.error(
                f"Error disconnecting from server {server_id}: {e}",
                extra={"server_id": server_id},
            )

    # ✅ 2. 清理所有字典
    self._servers.clear()
    self._connections.clear()
    self._connection_status.clear()

    logger.info("All MCP connections closed and resources cleaned up")
```

---

## 完整修复代码

```python
# runtime/src/mcp/client.py

from typing import Dict, Any, Optional
from enum import Enum
import asyncio

from src.utils.logging import get_logger

logger = get_logger(__name__)


class ConnectionStatus(Enum):
    DISCONNECTED = "disconnected"
    CONNECTING = "connecting"
    CONNECTED = "connected"
    ERROR = "error"


class MCPClient:
    """MCP (Model Context Protocol) Client."""

    def __init__(self):
        self._servers: Dict[str, Any] = {}
        self._connections: Dict[str, Any] = {}
        self._connection_status: Dict[str, ConnectionStatus] = {}
        self._lock = asyncio.Lock()

    async def connect(self, server_id: str, config: Dict[str, Any]) -> bool:
        """Connect to an MCP server."""
        async with self._lock:
            if server_id in self._connections:
                logger.warning(f"Already connected to server {server_id}")
                return True

            self._connection_status[server_id] = ConnectionStatus.CONNECTING

            try:
                # 实际连接逻辑
                connection = await self._create_connection(config)
                self._connections[server_id] = connection
                self._servers[server_id] = config
                self._connection_status[server_id] = ConnectionStatus.CONNECTED

                logger.info(f"Connected to MCP server {server_id}")
                return True

            except Exception as e:
                self._connection_status[server_id] = ConnectionStatus.ERROR
                logger.error(f"Failed to connect to server {server_id}: {e}")
                raise

    async def disconnect(self, server_id: str) -> bool:
        """Disconnect from an MCP server."""
        async with self._lock:
            if server_id not in self._connections:
                logger.warning(f"Not connected to server {server_id}")
                return False

            try:
                connection = self._connections[server_id]
                if hasattr(connection, 'close'):
                    await connection.close()

                # 清理该服务器的资源
                del self._connections[server_id]
                del self._servers[server_id]
                self._connection_status[server_id] = ConnectionStatus.DISCONNECTED

                logger.info(f"Disconnected from MCP server {server_id}")
                return True

            except Exception as e:
                logger.error(f"Error disconnecting from server {server_id}: {e}")
                raise

    async def close_all(self) -> None:
        """Close all MCP connections and clean up resources."""
        logger.info("Closing all MCP connections")

        # 获取所有服务器 ID 的副本（避免在迭代时修改）
        server_ids = list(self._servers.keys())

        # 并行关闭所有连接
        tasks = []
        for server_id in server_ids:
            tasks.append(self._safe_disconnect(server_id))

        if tasks:
            await asyncio.gather(*tasks)

        # ✅ 确保所有字典都被清理
        async with self._lock:
            self._servers.clear()
            self._connections.clear()
            self._connection_status.clear()

        logger.info(
            "All MCP connections closed and resources cleaned up",
            extra={"closed_count": len(server_ids)}
        )

    async def _safe_disconnect(self, server_id: str) -> None:
        """Safely disconnect from a server, catching exceptions."""
        try:
            await self.disconnect(server_id)
        except Exception as e:
            logger.error(
                f"Error disconnecting from server {server_id}: {e}",
                extra={"server_id": server_id},
            )

    async def _create_connection(self, config: Dict[str, Any]) -> Any:
        """Create a connection to an MCP server."""
        # TODO: Implement actual connection logic
        pass

    def get_status(self, server_id: str) -> Optional[ConnectionStatus]:
        """Get the connection status of a server."""
        return self._connection_status.get(server_id)

    def get_all_statuses(self) -> Dict[str, ConnectionStatus]:
        """Get the connection status of all servers."""
        return dict(self._connection_status)

    @property
    def connected_count(self) -> int:
        """Get the number of connected servers."""
        return sum(
            1 for status in self._connection_status.values()
            if status == ConnectionStatus.CONNECTED
        )
```

---

## 测试验证

### 单元测试
```python
# runtime/tests/mcp/test_client.py

import pytest
from unittest.mock import AsyncMock, patch
from src.mcp.client import MCPClient, ConnectionStatus


class TestMCPClient:
    @pytest.fixture
    def client(self):
        return MCPClient()

    @pytest.mark.asyncio
    async def test_close_all_clears_dictionaries(self, client):
        """测试 close_all 清理所有字典"""
        # 模拟一些连接
        client._servers = {"s1": {}, "s2": {}}
        client._connections = {"s1": AsyncMock(), "s2": AsyncMock()}
        client._connection_status = {
            "s1": ConnectionStatus.CONNECTED,
            "s2": ConnectionStatus.CONNECTED
        }

        await client.close_all()

        # 验证所有字典都被清理
        assert len(client._servers) == 0
        assert len(client._connections) == 0
        assert len(client._connection_status) == 0

    @pytest.mark.asyncio
    async def test_close_all_handles_errors(self, client):
        """测试 close_all 处理断开连接错误"""
        mock_conn = AsyncMock()
        mock_conn.close.side_effect = Exception("Connection error")

        client._servers = {"s1": {}}
        client._connections = {"s1": mock_conn}
        client._connection_status = {"s1": ConnectionStatus.CONNECTED}

        # 不应该抛出异常
        await client.close_all()

        # 字典仍然应该被清理
        assert len(client._servers) == 0
        assert len(client._connections) == 0

    @pytest.mark.asyncio
    async def test_close_all_concurrent_safe(self, client):
        """测试 close_all 并发安全"""
        client._servers = {"s1": {}, "s2": {}, "s3": {}}
        client._connections = {
            "s1": AsyncMock(),
            "s2": AsyncMock(),
            "s3": AsyncMock()
        }
        client._connection_status = {
            "s1": ConnectionStatus.CONNECTED,
            "s2": ConnectionStatus.CONNECTED,
            "s3": ConnectionStatus.CONNECTED
        }

        # 并发调用 close_all
        await asyncio.gather(
            client.close_all(),
            client.close_all()
        )

        # 应该正常完成，字典被清理
        assert len(client._servers) == 0
```

---

## 修复清单

- [ ] 修改 `close_all` 方法添加字典清理
- [ ] 添加 `_safe_disconnect` 辅助方法
- [ ] 使用 `asyncio.gather` 并行关闭连接
- [ ] 添加锁保护并发安全
- [ ] 添加单元测试
- [ ] 代码审查

---

## 完成标准

- [ ] `close_all` 清理所有内部字典
- [ ] 错误处理不影响清理流程
- [ ] 并发安全
- [ ] 单元测试通过
- [ ] 代码审查通过

---

## 相关文档

- [并发规范 - 资源关闭](.claude/rules/concurrency.md#资源关闭)
