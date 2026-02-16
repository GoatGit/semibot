"""Code Executor Tool implementation.

Provides safe code execution in isolated environments.
"""

import asyncio
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any

from src.server.file_manager import FileManager
from src.skills.base import BaseTool, ToolResult
from src.utils.logging import get_logger

logger = get_logger(__name__)

# Module-level FileManager instance, set by app lifespan
_file_manager: FileManager | None = None


def set_file_manager(fm: FileManager) -> None:
    """Set the module-level FileManager (called during app startup)."""
    global _file_manager
    _file_manager = fm


class CodeExecutorTool(BaseTool):
    """
    Code execution tool with sandboxing.

    Supports:
    - Python code execution (fpdf2 available for PDF generation)
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
            "Returns stdout, stderr, and exit code. "
            "Python environment has these libraries pre-installed: "
            "fpdf2 (PDF generation), openpyxl (Excel/XLSX generation), reportlab (advanced PDF). "
            "Do NOT use pandas — it is NOT installed. Use openpyxl directly for spreadsheets. "
            "IMPORTANT: Any output files (PDF, CSV, XLSX, images, etc.) MUST be saved "
            "to the current working directory using a relative path (e.g. "
            "'report.pdf', 'data.xlsx', NOT '/tmp/report.pdf'). Files saved to the current "
            "directory will be automatically collected and made available for download. "
            "NOTE for PDF: fpdf2's built-in fonts (Helvetica, Times, Courier) do NOT "
            "support CJK characters. For Chinese/Japanese/Korean text, you MUST use: "
            "pdf.add_font('HiraginoGB', '', '/System/Library/Fonts/Hiragino Sans GB.ttc', uni=True) "
            "and then pdf.set_font('HiraginoGB', size=...). "
            "ALWAYS use Chinese fonts and write content in Chinese when the user's request is in Chinese. "
            "Each code execution runs in an isolated environment — you cannot reference "
            "variables or results from previous steps. Include all necessary data and "
            "logic within a single code block."
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

            result = await self._run_process(
                [sys.executable, str(script_path)],
                stdin=stdin,
                cwd=tmpdir,
            )

            generated_files = self._collect_output_files(tmpdir, {"script.py"})
            if generated_files:
                result.metadata["generated_files"] = generated_files

            return result

    async def _execute_javascript(
        self,
        code: str,
        stdin: str | None = None,
    ) -> ToolResult:
        """Execute JavaScript code with Node.js."""
        with tempfile.TemporaryDirectory() as tmpdir:
            script_path = Path(tmpdir) / "script.js"
            script_path.write_text(code)

            result = await self._run_process(
                ["node", str(script_path)],
                stdin=stdin,
                cwd=tmpdir,
            )

            generated_files = self._collect_output_files(tmpdir, {"script.js"})
            if generated_files:
                result.metadata["generated_files"] = generated_files

            return result

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

            result = await self._run_process(
                ["bash", str(script_path)],
                stdin=stdin,
                cwd=tmpdir,
            )

            generated_files = self._collect_output_files(tmpdir, {"script.sh"})
            if generated_files:
                result.metadata["generated_files"] = generated_files

            return result

    def _collect_output_files(
        self,
        work_dir: str,
        exclude: set[str],
    ) -> list[dict[str, Any]]:
        """Scan work_dir for generated files and persist them via FileManager.

        Args:
            work_dir: The temporary working directory
            exclude: Filenames to skip (e.g. the script itself)

        Returns:
            List of file metadata dicts from FileManager.persist_file
        """
        if _file_manager is None:
            logger.debug("FileManager not available, skipping file collection")
            return []

        collected: list[dict[str, Any]] = []
        work_path = Path(work_dir)

        # Recursively scan for all files (handles subdirectories too)
        for entry in work_path.rglob("*"):
            if not entry.is_file():
                continue
            if entry.name in exclude:
                continue

            logger.info(
                "Found output file: %s (size: %d)",
                entry.name,
                entry.stat().st_size,
            )

            meta = _file_manager.persist_file(entry)
            if meta is not None:
                collected.append(meta)

        if collected:
            logger.info(
                "Collected %d output file(s) from code execution",
                len(collected),
            )
        else:
            # Log all files in work_dir for debugging
            all_files = list(work_path.rglob("*"))
            logger.debug(
                "No eligible output files found in work_dir (total files: %d, entries: %s)",
                len(all_files),
                [str(f.relative_to(work_path)) for f in all_files],
            )

        return collected

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
