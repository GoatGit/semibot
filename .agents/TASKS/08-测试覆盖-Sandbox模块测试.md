# 任务：Sandbox 模块测试

**优先级**: 🔴 P0 - 严重
**类型**: 测试覆盖
**预估工时**: 3-5 天
**影响范围**: runtime/src/sandbox/ 目录

---

## 问题描述

Sandbox 模块是**安全关键模块**，负责代码执行隔离，但**完全缺失测试**。这是严重的安全风险。

---

## 模块概述

**源代码文件**:
- `runtime/src/sandbox/manager.py` (22,189 字节) - 核心管理器
- `runtime/src/sandbox/policy.py` (14,238 字节) - 安全策略
- `runtime/src/sandbox/audit.py` (9,934 字节) - 审计日志
- `runtime/src/sandbox/exceptions.py` - 异常定义
- `runtime/src/sandbox/models.py` - 数据模型

**测试文件**: ❌ **完全缺失**

---

## 需要补充的测试

### 1. 单元测试

#### 1.1 SandboxManager 测试
```python
# runtime/tests/sandbox/test_manager.py

import pytest
from unittest.mock import Mock, patch, AsyncMock
from src.sandbox.manager import SandboxManager
from src.sandbox.models import SandboxConfig, ExecutionResult
from src.sandbox.exceptions import SandboxCreationError, ExecutionTimeoutError


class TestSandboxManager:
    """SandboxManager 单元测试"""

    @pytest.fixture
    def manager(self):
        """创建测试用的 SandboxManager"""
        return SandboxManager(
            docker_image="python:3.11-slim",
            max_memory="256m",
            max_cpu="0.5",
            timeout_seconds=30
        )

    @pytest.mark.asyncio
    async def test_create_sandbox_success(self, manager):
        """测试成功创建 Sandbox"""
        with patch.object(manager, '_create_container', new_callable=AsyncMock) as mock_create:
            mock_create.return_value = "container-123"

            sandbox_id = await manager.create_sandbox()

            assert sandbox_id is not None
            assert sandbox_id == "container-123"
            mock_create.assert_called_once()

    @pytest.mark.asyncio
    async def test_create_sandbox_failure(self, manager):
        """测试创建 Sandbox 失败"""
        with patch.object(manager, '_create_container', new_callable=AsyncMock) as mock_create:
            mock_create.side_effect = Exception("Docker error")

            with pytest.raises(SandboxCreationError):
                await manager.create_sandbox()

    @pytest.mark.asyncio
    async def test_execute_code_success(self, manager):
        """测试成功执行代码"""
        with patch.object(manager, '_run_in_container', new_callable=AsyncMock) as mock_run:
            mock_run.return_value = ExecutionResult(
                stdout="Hello, World!",
                stderr="",
                exit_code=0,
                execution_time=0.5
            )

            result = await manager.execute_code(
                sandbox_id="container-123",
                code="print('Hello, World!')",
                language="python"
            )

            assert result.exit_code == 0
            assert "Hello, World!" in result.stdout

    @pytest.mark.asyncio
    async def test_execute_code_timeout(self, manager):
        """测试代码执行超时"""
        with patch.object(manager, '_run_in_container', new_callable=AsyncMock) as mock_run:
            mock_run.side_effect = ExecutionTimeoutError("Execution timed out")

            with pytest.raises(ExecutionTimeoutError):
                await manager.execute_code(
                    sandbox_id="container-123",
                    code="while True: pass",
                    language="python"
                )

    @pytest.mark.asyncio
    async def test_destroy_sandbox(self, manager):
        """测试销毁 Sandbox"""
        with patch.object(manager, '_remove_container', new_callable=AsyncMock) as mock_remove:
            mock_remove.return_value = True

            result = await manager.destroy_sandbox("container-123")

            assert result is True
            mock_remove.assert_called_once_with("container-123")

    @pytest.mark.asyncio
    async def test_cleanup_expired_sandboxes(self, manager):
        """测试清理过期的 Sandbox"""
        with patch.object(manager, '_get_expired_containers', new_callable=AsyncMock) as mock_get:
            with patch.object(manager, '_remove_container', new_callable=AsyncMock) as mock_remove:
                mock_get.return_value = ["container-1", "container-2"]
                mock_remove.return_value = True

                count = await manager.cleanup_expired()

                assert count == 2
                assert mock_remove.call_count == 2
```

#### 1.2 SecurityPolicy 测试
```python
# runtime/tests/sandbox/test_policy.py

import pytest
from src.sandbox.policy import SecurityPolicy, PolicyViolation


class TestSecurityPolicy:
    """安全策略测试"""

    @pytest.fixture
    def policy(self):
        """创建默认安全策略"""
        return SecurityPolicy()

    def test_block_dangerous_imports(self, policy):
        """测试阻止危险的导入"""
        dangerous_code = """
import os
os.system('rm -rf /')
"""
        with pytest.raises(PolicyViolation) as exc_info:
            policy.validate_code(dangerous_code)

        assert "os.system" in str(exc_info.value)

    def test_block_network_access(self, policy):
        """测试阻止网络访问"""
        network_code = """
import socket
s = socket.socket()
s.connect(('example.com', 80))
"""
        with pytest.raises(PolicyViolation) as exc_info:
            policy.validate_code(network_code)

        assert "socket" in str(exc_info.value)

    def test_block_file_write(self, policy):
        """测试阻止文件写入"""
        file_code = """
with open('/etc/passwd', 'w') as f:
    f.write('malicious')
"""
        with pytest.raises(PolicyViolation) as exc_info:
            policy.validate_code(file_code)

        assert "file write" in str(exc_info.value).lower()

    def test_allow_safe_code(self, policy):
        """测试允许安全代码"""
        safe_code = """
def calculate(a, b):
    return a + b

result = calculate(1, 2)
print(result)
"""
        # 不应该抛出异常
        policy.validate_code(safe_code)

    def test_memory_limit_enforcement(self, policy):
        """测试内存限制"""
        memory_hog_code = """
data = []
for i in range(10**9):
    data.append(i)
"""
        # 这个测试需要实际执行来验证
        assert policy.max_memory_mb == 256  # 默认值

    def test_cpu_limit_enforcement(self, policy):
        """测试 CPU 限制"""
        assert policy.max_cpu_percent == 50  # 默认值

    def test_timeout_enforcement(self, policy):
        """测试超时限制"""
        assert policy.timeout_seconds == 30  # 默认值

    def test_custom_policy(self):
        """测试自定义策略"""
        custom_policy = SecurityPolicy(
            allowed_imports=["math", "json"],
            max_memory_mb=128,
            max_cpu_percent=25,
            timeout_seconds=10
        )

        assert custom_policy.max_memory_mb == 128
        assert custom_policy.max_cpu_percent == 25
        assert custom_policy.timeout_seconds == 10

        # 应该允许 math
        custom_policy.validate_code("import math")

        # 应该阻止 os
        with pytest.raises(PolicyViolation):
            custom_policy.validate_code("import os")
```

#### 1.3 Audit 测试
```python
# runtime/tests/sandbox/test_audit.py

import pytest
from datetime import datetime
from src.sandbox.audit import SandboxAuditLogger, AuditEvent


class TestSandboxAuditLogger:
    """Sandbox 审计日志测试"""

    @pytest.fixture
    def logger(self):
        """创建审计日志记录器"""
        return SandboxAuditLogger()

    @pytest.mark.asyncio
    async def test_log_sandbox_creation(self, logger):
        """测试记录 Sandbox 创建"""
        event = await logger.log_creation(
            sandbox_id="container-123",
            user_id="user-456",
            config={"memory": "256m", "cpu": "0.5"}
        )

        assert event.event_type == "SANDBOX_CREATED"
        assert event.sandbox_id == "container-123"
        assert event.user_id == "user-456"
        assert event.timestamp is not None

    @pytest.mark.asyncio
    async def test_log_code_execution(self, logger):
        """测试记录代码执行"""
        event = await logger.log_execution(
            sandbox_id="container-123",
            code="print('hello')",
            language="python",
            result={"exit_code": 0, "output": "hello"}
        )

        assert event.event_type == "CODE_EXECUTED"
        assert event.sandbox_id == "container-123"
        assert "python" in event.details

    @pytest.mark.asyncio
    async def test_log_policy_violation(self, logger):
        """测试记录策略违规"""
        event = await logger.log_violation(
            sandbox_id="container-123",
            violation_type="DANGEROUS_IMPORT",
            details={"import": "os", "code_snippet": "import os"}
        )

        assert event.event_type == "POLICY_VIOLATION"
        assert event.sandbox_id == "container-123"
        assert event.severity == "HIGH"

    @pytest.mark.asyncio
    async def test_log_sandbox_destruction(self, logger):
        """测试记录 Sandbox 销毁"""
        event = await logger.log_destruction(
            sandbox_id="container-123",
            reason="USER_REQUEST"
        )

        assert event.event_type == "SANDBOX_DESTROYED"
        assert event.sandbox_id == "container-123"

    @pytest.mark.asyncio
    async def test_query_audit_logs(self, logger):
        """测试查询审计日志"""
        # 创建一些日志
        await logger.log_creation("c1", "u1", {})
        await logger.log_creation("c2", "u1", {})
        await logger.log_creation("c3", "u2", {})

        # 按用户查询
        logs = await logger.query(user_id="u1")
        assert len(logs) == 2

        # 按 Sandbox 查询
        logs = await logger.query(sandbox_id="c1")
        assert len(logs) == 1
```

### 2. 集成测试

```python
# runtime/tests/sandbox/test_integration.py

import pytest
import asyncio
from src.sandbox.manager import SandboxManager
from src.sandbox.policy import SecurityPolicy


@pytest.mark.integration
class TestSandboxIntegration:
    """Sandbox 集成测试（需要 Docker）"""

    @pytest.fixture
    async def manager(self):
        """创建真实的 SandboxManager"""
        manager = SandboxManager()
        yield manager
        # 清理所有测试创建的容器
        await manager.cleanup_all()

    @pytest.mark.asyncio
    async def test_full_lifecycle(self, manager):
        """测试完整的生命周期"""
        # 1. 创建 Sandbox
        sandbox_id = await manager.create_sandbox()
        assert sandbox_id is not None

        # 2. 执行代码
        result = await manager.execute_code(
            sandbox_id=sandbox_id,
            code="print(1 + 1)",
            language="python"
        )
        assert result.exit_code == 0
        assert "2" in result.stdout

        # 3. 销毁 Sandbox
        destroyed = await manager.destroy_sandbox(sandbox_id)
        assert destroyed is True

    @pytest.mark.asyncio
    async def test_memory_limit(self, manager):
        """测试内存限制"""
        sandbox_id = await manager.create_sandbox(max_memory="64m")

        # 尝试分配大量内存
        result = await manager.execute_code(
            sandbox_id=sandbox_id,
            code="data = [0] * (100 * 1024 * 1024)",  # 尝试分配 100MB
            language="python"
        )

        # 应该失败或被杀死
        assert result.exit_code != 0 or "MemoryError" in result.stderr

        await manager.destroy_sandbox(sandbox_id)

    @pytest.mark.asyncio
    async def test_timeout(self, manager):
        """测试超时"""
        sandbox_id = await manager.create_sandbox(timeout_seconds=2)

        # 执行无限循环
        result = await manager.execute_code(
            sandbox_id=sandbox_id,
            code="while True: pass",
            language="python"
        )

        # 应该超时
        assert result.timed_out is True

        await manager.destroy_sandbox(sandbox_id)

    @pytest.mark.asyncio
    async def test_network_isolation(self, manager):
        """测试网络隔离"""
        sandbox_id = await manager.create_sandbox(network_enabled=False)

        result = await manager.execute_code(
            sandbox_id=sandbox_id,
            code="""
import urllib.request
urllib.request.urlopen('http://example.com')
""",
            language="python"
        )

        # 网络请求应该失败
        assert result.exit_code != 0

        await manager.destroy_sandbox(sandbox_id)

    @pytest.mark.asyncio
    async def test_file_system_isolation(self, manager):
        """测试文件系统隔离"""
        sandbox_id = await manager.create_sandbox()

        # 尝试读取敏感文件
        result = await manager.execute_code(
            sandbox_id=sandbox_id,
            code="print(open('/etc/passwd').read())",
            language="python"
        )

        # 应该失败或返回空
        assert result.exit_code != 0 or "/etc/passwd" not in result.stdout

        await manager.destroy_sandbox(sandbox_id)

    @pytest.mark.asyncio
    async def test_concurrent_execution(self, manager):
        """测试并发执行"""
        sandbox_ids = []

        # 创建 5 个 Sandbox
        for _ in range(5):
            sandbox_id = await manager.create_sandbox()
            sandbox_ids.append(sandbox_id)

        # 并发执行代码
        tasks = [
            manager.execute_code(sid, f"print({i})", "python")
            for i, sid in enumerate(sandbox_ids)
        ]
        results = await asyncio.gather(*tasks)

        # 所有执行应该成功
        for i, result in enumerate(results):
            assert result.exit_code == 0
            assert str(i) in result.stdout

        # 清理
        for sid in sandbox_ids:
            await manager.destroy_sandbox(sid)
```

### 3. 安全测试

```python
# runtime/tests/sandbox/test_security.py

import pytest
from src.sandbox.manager import SandboxManager
from src.sandbox.policy import SecurityPolicy, PolicyViolation


@pytest.mark.security
class TestSandboxSecurity:
    """Sandbox 安全测试"""

    @pytest.fixture
    def policy(self):
        return SecurityPolicy()

    def test_block_subprocess(self, policy):
        """测试阻止 subprocess"""
        code = "import subprocess; subprocess.run(['ls'])"
        with pytest.raises(PolicyViolation):
            policy.validate_code(code)

    def test_block_eval(self, policy):
        """测试阻止 eval"""
        code = "eval('__import__(\"os\").system(\"ls\")')"
        with pytest.raises(PolicyViolation):
            policy.validate_code(code)

    def test_block_exec(self, policy):
        """测试阻止 exec"""
        code = "exec('import os; os.system(\"ls\")')"
        with pytest.raises(PolicyViolation):
            policy.validate_code(code)

    def test_block_pickle(self, policy):
        """测试阻止 pickle（可能导致 RCE）"""
        code = "import pickle; pickle.loads(malicious_data)"
        with pytest.raises(PolicyViolation):
            policy.validate_code(code)

    def test_block_ctypes(self, policy):
        """测试阻止 ctypes（可能绕过沙箱）"""
        code = "import ctypes"
        with pytest.raises(PolicyViolation):
            policy.validate_code(code)

    def test_block_multiprocessing(self, policy):
        """测试阻止 multiprocessing"""
        code = "from multiprocessing import Process"
        with pytest.raises(PolicyViolation):
            policy.validate_code(code)

    def test_block_signal(self, policy):
        """测试阻止 signal"""
        code = "import signal; signal.signal(signal.SIGKILL, handler)"
        with pytest.raises(PolicyViolation):
            policy.validate_code(code)

    def test_block_resource_modification(self, policy):
        """测试阻止资源限制修改"""
        code = "import resource; resource.setrlimit(resource.RLIMIT_NOFILE, (999999, 999999))"
        with pytest.raises(PolicyViolation):
            policy.validate_code(code)
```

---

## 测试目录结构

```
runtime/tests/sandbox/
├── __init__.py
├── conftest.py              # pytest fixtures
├── test_manager.py          # SandboxManager 单元测试
├── test_policy.py           # SecurityPolicy 单元测试
├── test_audit.py            # SandboxAuditLogger 单元测试
├── test_models.py           # 数据模型测试
├── test_exceptions.py       # 异常测试
├── test_integration.py      # 集成测试（需要 Docker）
└── test_security.py         # 安全测试
```

---

## 修复清单

- [ ] 创建 `runtime/tests/sandbox/` 目录
- [ ] 创建 `conftest.py` 配置文件
- [ ] 创建 `test_manager.py` - SandboxManager 测试
- [ ] 创建 `test_policy.py` - SecurityPolicy 测试
- [ ] 创建 `test_audit.py` - 审计日志测试
- [ ] 创建 `test_models.py` - 数据模型测试
- [ ] 创建 `test_exceptions.py` - 异常测试
- [ ] 创建 `test_integration.py` - 集成测试
- [ ] 创建 `test_security.py` - 安全测试
- [ ] 运行测试并确保通过
- [ ] 检查测试覆盖率 >= 80%

---

## 完成标准

- [ ] 所有单元测试通过
- [ ] 所有集成测试通过
- [ ] 所有安全测试通过
- [ ] 测试覆盖率 >= 80%
- [ ] 代码审查通过
- [ ] CI 集成通过

---

## 相关文档

- [测试规范](docs/design/TESTING.md)
- [Sandbox 安全设计](docs/sandbox-security-design.md)
