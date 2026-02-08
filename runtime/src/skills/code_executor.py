"""Code Executor Tool implementation.

Provides safe code execution in isolated environments.
"""

import asyncio
import subprocess
import tempfile
from pathlib import Path
from typing import Any

from src.skills.base import BaseTool, ToolResult
from src.utils.logging import get_logger

logger = get_logger(__name__)


class CodeExecutorTool(BaseTool):
    """
    Code execution tool with sandboxing.

    Supports:
    - Python code execution
    - JavaScript (Node.js) execution
    - Shell script execution

    Security features:
    - Timeout enforcement
    - Output size limits
    - Isolated temp directories

    Example:
        ```python
        tool = CodeExecutorTool(timeout=30)

        result = await tool.execute(
            language="python",
            code="print(1 + 1)",
        )
        ```
    """

    def __init__(
        self,
        timeout: int = 60,
        max_output_size: int = 100000,
        allowed_languages: list[str] | None = None,
    ):
        """
        Initialize the code executor.

        Args:
            timeout: Maximum execution time in seconds
            max_output_size: Maximum output size in characters
            allowed_languages: List of allowed languages (default: all)
        """
        self.timeout = timeout
        self.max_output_size = max_output_size
        self.allowed_languages = allowed_languages or ["python", "javascript", "shell"]

    @property
    def name(self) -> str:
        return "code_executor"

    @property
    def description(self) -> str:
        return (
            "Execute code in various programming languages. "
            "Supports Python, JavaScript (Node.js), and shell scripts. "
            "Returns stdout, stderr, and exit code."
        )

    @property
    def parameters(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "language": {
                    "type": "string",
                    "enum": ["python", "javascript", "shell"],
                    "description": "Programming language to execute",
                },
                "code": {
                    "type": "string",
                    "description": "Code to execute",
                },
                "stdin": {
                    "type": "string",
                    "description": "Optional input to provide to the program",
                },
            },
            "required": ["language", "code"],
        }

    async def execute(
        self,
        language: str,
        code: str,
        stdin: str | None = None,
        **kwargs: Any,
    ) -> ToolResult:
        """
        Execute code in the specified language.

        Args:
            language: Programming language
            code: Code to execute
            stdin: Optional input

        Returns:
            ToolResult with stdout, stderr, and exit code
        """
        if language not in self.allowed_languages:
            return ToolResult.error_result(
                f"Language '{language}' not allowed. Allowed: {self.allowed_languages}"
            )

        try:
            if language == "python":
                return await self._execute_python(code, stdin)
            elif language == "javascript":
                return await self._execute_javascript(code, stdin)
            elif language == "shell":
                return await self._execute_shell(code, stdin)
            else:
                return ToolResult.error_result(f"Unknown language: {language}")

        except asyncio.TimeoutError:
            return ToolResult.error_result(
                f"Execution timed out after {self.timeout} seconds"
            )
        except Exception as e:
            logger.error(f"Code execution failed: {e}")
            return ToolResult.error_result(f"Execution failed: {str(e)}")

    async def _execute_python(
        self,
        code: str,
        stdin: str | None = None,
    ) -> ToolResult:
        """Execute Python code."""
        with tempfile.TemporaryDirectory() as tmpdir:
            script_path = Path(tmpdir) / "script.py"
            script_path.write_text(code)

            return await self._run_process(
                ["python3", str(script_path)],
                stdin=stdin,
                cwd=tmpdir,
            )

    async def _execute_javascript(
        self,
        code: str,
        stdin: str | None = None,
    ) -> ToolResult:
        """Execute JavaScript code with Node.js."""
        with tempfile.TemporaryDirectory() as tmpdir:
            script_path = Path(tmpdir) / "script.js"
            script_path.write_text(code)

            return await self._run_process(
                ["node", str(script_path)],
                stdin=stdin,
                cwd=tmpdir,
            )

    async def _execute_shell(
        self,
        code: str,
        stdin: str | None = None,
    ) -> ToolResult:
        """Execute shell script."""
        with tempfile.TemporaryDirectory() as tmpdir:
            script_path = Path(tmpdir) / "script.sh"
            script_path.write_text(code)
            script_path.chmod(0o755)

            return await self._run_process(
                ["bash", str(script_path)],
                stdin=stdin,
                cwd=tmpdir,
            )

    async def _run_process(
        self,
        cmd: list[str],
        stdin: str | None = None,
        cwd: str | None = None,
    ) -> ToolResult:
        """Run a subprocess with timeout."""
        try:
            process = await asyncio.create_subprocess_exec(
                *cmd,
                stdin=subprocess.PIPE if stdin else None,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                cwd=cwd,
            )

            stdout_bytes, stderr_bytes = await asyncio.wait_for(
                process.communicate(input=stdin.encode() if stdin else None),
                timeout=self.timeout,
            )

            stdout = stdout_bytes.decode("utf-8", errors="replace")
            stderr = stderr_bytes.decode("utf-8", errors="replace")

            # Truncate if necessary
            if len(stdout) > self.max_output_size:
                stdout = stdout[: self.max_output_size] + "\n... (output truncated)"
                logger.warning(
                    f"Output truncated from {len(stdout_bytes)} to {self.max_output_size} chars"
                )

            if len(stderr) > self.max_output_size:
                stderr = stderr[: self.max_output_size] + "\n... (output truncated)"

            result = {
                "stdout": stdout,
                "stderr": stderr,
                "exit_code": process.returncode,
            }

            if process.returncode == 0:
                return ToolResult.success_result(result)
            else:
                return ToolResult(
                    success=False,
                    result=result,
                    error=f"Process exited with code {process.returncode}",
                )

        except asyncio.TimeoutError:
            # Try to kill the process
            try:
                process.kill()
                await process.wait()
            except Exception:
                pass
            raise
