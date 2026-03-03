from pathlib import Path

import pytest

from src.skills.code_executor import CodeExecutorTool, set_file_manager
from src.storage.file_manager import FileManager


@pytest.mark.asyncio
async def test_code_executor_collects_generated_files_without_manual_injection(tmp_path: Path) -> None:
    # Reset to default manager created at import time.
    set_file_manager(FileManager())
    tool = CodeExecutorTool(timeout=20)
    result = await tool.execute(
        language="python",
        code="open('hello.txt','w',encoding='utf-8').write('ok')\nprint('done')",
    )
    assert result.success is True
    generated = (result.metadata or {}).get("generated_files", [])
    assert isinstance(generated, list)
    assert generated
    assert generated[0]["filename"] == "hello.txt"
    assert Path(generated[0]["path"]).exists()
