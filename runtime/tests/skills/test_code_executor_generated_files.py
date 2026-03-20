from pathlib import Path
from types import SimpleNamespace

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
    assert Path(generated[0]["source_path"]).exists()
    assert generated[0]["artifact_role"] == "report_md"


@pytest.mark.asyncio
async def test_code_executor_uses_session_working_dir_when_runtime_context_provided(tmp_path: Path) -> None:
    set_file_manager(FileManager())
    tool = CodeExecutorTool(timeout=20)
    runtime_context = SimpleNamespace(metadata={"session_working_dir": str(tmp_path / "workspaces" / "s1")})
    result = await tool.execute(
        language="python",
        code="open('hello.txt','w',encoding='utf-8').write('ok')\nprint('done')",
        _runtime_context=runtime_context,
    )

    assert result.success is True
    generated = (result.metadata or {}).get("generated_files", [])
    assert generated
    assert "tool_runs" in generated[0]["source_path"]


@pytest.mark.asyncio
async def test_code_executor_marks_internal_plan_json_as_hidden(tmp_path: Path) -> None:
    set_file_manager(FileManager())
    tool = CodeExecutorTool(timeout=20)
    result = await tool.execute(
        language="python",
        code=(
            "open('research_plan.json','w',encoding='utf-8').write('{\"ok\":true}')\n"
            "open('report.pdf','wb').write(b'%PDF-1.4\\n%%EOF')\n"
            "print('done')"
        ),
    )
    assert result.success is True
    generated = (result.metadata or {}).get("generated_files", [])
    assert isinstance(generated, list)
    hidden = next(item for item in generated if item["filename"] == "research_plan.json")
    visible = next(item for item in generated if item["filename"] == "report.pdf")
    assert hidden["user_visible"] is False
    assert visible["user_visible"] is True
    assert hidden["artifact_role"] == "data_json"
    assert visible["artifact_role"] == "report_pdf"


def test_code_executor_schema_is_generic_and_excludes_context_data() -> None:
    tool = CodeExecutorTool()

    assert tool.parameters["properties"]["language"]["type"] == "string"
    assert tool.parameters["properties"]["code"]["type"] == "string"
    assert tool.parameters["properties"]["stdin"]["type"] == "string"
    assert tool.parameters["properties"]["workdir"]["type"] == "string"
    assert "context_data" not in tool.parameters["properties"]
    assert "language (string)" in tool.description
    assert "code (string)" in tool.description
    assert "stdin (optional string)" in tool.description
    assert "workdir (optional string)" in tool.description
    assert "stdout (string)" in tool.description
    assert "stderr (string)" in tool.description
    assert "exit_code (integer)" in tool.description


@pytest.mark.asyncio
async def test_code_executor_shell_uses_session_workspace_workdir(tmp_path: Path) -> None:
    set_file_manager(FileManager())
    tool = CodeExecutorTool(timeout=20)
    session_root = tmp_path / "workspaces" / "s1"
    runtime_context = SimpleNamespace(metadata={"session_working_dir": str(session_root)})

    result = await tool.execute(
        language="shell",
        code="pwd && mkdir -p reports && printf 'done' > reports/out.txt",
        workdir="scripts",
        _runtime_context=runtime_context,
    )

    assert result.success is True
    payload = result.result or {}
    assert str(payload.get("stdout") or "").splitlines()[0].endswith("/workspaces/s1/scripts")
    assert (result.metadata or {}).get("work_dir") == str((session_root / "scripts").resolve())
    generated = (result.metadata or {}).get("generated_files", [])
    assert len(generated) == 1
    assert generated[0]["filename"] == "out.txt"
    assert Path(generated[0]["source_path"]).resolve() == (session_root / "scripts" / "reports" / "out.txt").resolve()
