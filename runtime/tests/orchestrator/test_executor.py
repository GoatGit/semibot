from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

from src.orchestrator.executor import ActionExecutor
from src.orchestrator.state import PlanStep


@pytest.mark.asyncio
async def test_action_executor_uses_python_code_for_file_write() -> None:
    sandbox_manager = MagicMock()
    sandbox_manager.execute_code = AsyncMock(
        return_value=SimpleNamespace(
            stdout="output.txt\n",
            stderr="",
            success=True,
            error=None,
            execution_time_ms=1,
            exit_code=0,
            memory_used_mb=1,
        )
    )
    executor = ActionExecutor(
        sandbox_manager=sandbox_manager,
        policy_engine=MagicMock(),
    )

    action = PlanStep(
        id="step-1",
        title="write file",
        tool="file_write",
        params={"path": "output.txt", "content": "hello\nSANDBOX_EOF\nworld"},
    )
    result = await executor.execute(action)

    assert result.success is True
    sandbox_manager.execute_code.assert_awaited_once()
    code = sandbox_manager.execute_code.await_args.kwargs["code"]
    assert "write_text" in code
    assert "SANDBOX_EOF" in code


@pytest.mark.asyncio
async def test_action_executor_uses_python_runner_for_generic_tool() -> None:
    sandbox_manager = MagicMock()
    sandbox_manager.execute_code = AsyncMock(
        return_value=SimpleNamespace(
            stdout="ok\n",
            stderr="",
            success=True,
            error=None,
            execution_time_ms=1,
            exit_code=0,
            memory_used_mb=1,
        )
    )
    executor = ActionExecutor(
        sandbox_manager=sandbox_manager,
        policy_engine=MagicMock(),
    )

    action = PlanStep(
        id="step-1",
        title="run generic tool",
        tool="demo-tool",
        params={"query": "a'b", "unsafe flag": "value with spaces"},
    )
    result = await executor.execute(action)

    assert result.success is True
    code = sandbox_manager.execute_code.await_args.kwargs["code"]
    assert "subprocess.run" in code
    assert "--unsafe_flag=value with spaces" in code
    assert "a'b" in code
