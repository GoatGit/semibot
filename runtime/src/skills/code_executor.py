"""Code Executor Tool implementation.

Provides safe code execution in isolated environments.
"""

import asyncio
import json
import os
import re
import subprocess
import sys
import tempfile
import uuid
from pathlib import Path
from typing import Any

from src.skills.base import BaseTool, ToolResult
from src.storage.file_manager import FileManager
from src.utils.logging import get_logger

logger = get_logger(__name__)

# Module-level FileManager instance.
# Keep a default instance so generated files are persisted in production even
# when app startup does not explicitly inject one.
_file_manager: FileManager | None = FileManager()


def _infer_artifact_role(path: Path) -> str:
    suffix = path.suffix.lower()
    if suffix in {".md", ".markdown", ".txt"}:
        return "report_md"
    if suffix in {".html", ".htm"}:
        return "report_html"
    if suffix == ".pdf":
        return "report_pdf"
    if suffix == ".json":
        return "data_json"
    return "file"


def _infer_artifact_semantics(path: Path, artifact_role: str) -> dict[str, Any]:
    role = str(artifact_role or "").strip().lower() or "file"
    lower_name = path.name.lower()
    semantic_type = "file"
    semantic_name = "generated file"
    semantic_purpose = "generated output artifact"
    is_likely_final = False

    if role in {"report_md", "report_html", "report_pdf"}:
        if "scope" in lower_name:
            semantic_type = "scope_definition"
            semantic_name = "scope definition"
            semantic_purpose = "research scope or outline artifact; usually intermediate, not the final deliverable"
        elif any(token in lower_name for token in ("search", "result", "retrieve", "retrieval", "source")):
            semantic_type = "search_results_summary"
            semantic_name = "search results summary"
            semantic_purpose = "search or evidence summary artifact used as intermediate input"
        elif any(token in lower_name for token in ("synth", "analysis", "summary", "draft")):
            semantic_type = "analysis_synthesis"
            semantic_name = "analysis synthesis draft"
            semantic_purpose = "analysis or synthesis draft artifact; may be intermediate unless it is explicitly the final report"
        else:
            semantic_type = "research_report"
            semantic_name = "report pdf" if role == "report_pdf" else "markdown report" if role == "report_md" else "report html"
            semantic_purpose = (
                "derived PDF report deliverable"
                if role == "report_pdf"
                else "primary markdown/text report artifact"
                if role == "report_md"
                else "derived HTML report deliverable"
            )
            is_likely_final = True
    elif role == "data_json":
        if "scope" in lower_name:
            semantic_type = "scope_definition_data"
            semantic_name = "scope definition data"
            semantic_purpose = "structured scope or outline data; intermediate planning artifact"
        elif any(token in lower_name for token in ("search", "result", "source", "retrieve", "retrieval")):
            semantic_type = "search_results_data"
            semantic_name = "search results data"
            semantic_purpose = "structured search/evidence data for downstream synthesis"
        elif any(token in lower_name for token in ("plan", "outline")):
            semantic_type = "plan_or_outline_data"
            semantic_name = "plan or outline data"
            semantic_purpose = "structured plan/outline artifact; intermediate"
        elif "context" in lower_name:
            semantic_type = "execution_context_data"
            semantic_name = "execution context data"
            semantic_purpose = "tool execution context artifact; intermediate"
        else:
            semantic_type = "structured_data"
            semantic_name = "structured data"
            semantic_purpose = "structured intermediate data artifact"

    return {
        "artifact_medium": "file",
        "artifact_format": path.suffix.lower().lstrip(".") or "binary",
        "artifact_type": semantic_type,
        "artifact_name": semantic_name,
        "artifact_purpose": semantic_purpose,
        "is_likely_final": is_likely_final,
    }


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
            "Execute code in Python, JavaScript (Node.js), or shell. "
            "Input parameters: language (string), code (string), stdin (optional string), workdir (optional string), timeout_ms (optional integer). "
            "Returns a process result object with stdout (string), stderr (string), and exit_code (integer). Shell uses bash. "
            "Python and JavaScript run in isolated working directories. Shell runs in the current session workspace, optionally under workdir. "
            "Execution has time and output limits. Files written with relative paths may be collected as generated outputs."
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
                    "description": "Source code or shell script to execute.",
                },
                "stdin": {
                    "type": "string",
                    "description": "Optional UTF-8 standard input text passed to the process.",
                },
                "workdir": {
                    "type": "string",
                    "description": "Optional relative working directory for shell execution inside the current session workspace.",
                },
                "timeout_ms": {
                    "type": "integer",
                    "description": "Optional timeout override in milliseconds for this execution.",
                },
            },
            "required": ["language", "code"],
        }

    @staticmethod
    def _resolve_session_working_root(runtime_context: Any | None) -> Path | None:
        metadata = getattr(runtime_context, "metadata", None)
        if not isinstance(metadata, dict):
            return None
        raw = metadata.get("session_working_dir")
        if not isinstance(raw, str) or not raw.strip():
            return None
        try:
            root = Path(raw).expanduser().resolve()
            root.mkdir(parents=True, exist_ok=True)
            return root
        except Exception:
            return None

    @staticmethod
    def _create_work_dir(runtime_context: Any | None, prefix: str) -> str:
        session_root = CodeExecutorTool._resolve_session_working_root(runtime_context)
        if session_root is None:
            return tempfile.mkdtemp(prefix=prefix)
        work_dir = session_root / "tool_runs" / f"{prefix}{uuid.uuid4().hex[:12]}"
        work_dir.mkdir(parents=True, exist_ok=True)
        return str(work_dir)

    @staticmethod
    def _resolve_shell_work_dir(runtime_context: Any | None, workdir: str | None) -> Path:
        session_root = CodeExecutorTool._resolve_session_working_root(runtime_context)
        if session_root is None:
            return Path(tempfile.mkdtemp(prefix="code_executor_sh_"))
        relative = str(workdir or ".").strip() or "."
        target = (session_root / relative).resolve()
        if target != session_root and session_root not in target.parents:
            raise ValueError(f"workdir escapes session workspace: {session_root}")
        target.mkdir(parents=True, exist_ok=True)
        return target

    @staticmethod
    def _snapshot_work_dir(work_dir: Path) -> dict[str, tuple[int, int]]:
        snapshot: dict[str, tuple[int, int]] = {}
        for entry in work_dir.rglob("*"):
            if not entry.is_file():
                continue
            try:
                stat = entry.stat()
            except Exception:
                continue
            snapshot[str(entry.resolve())] = (int(stat.st_mtime_ns), int(stat.st_size))
        return snapshot

    @staticmethod
    def _build_process_env(runtime_context: Any | None) -> dict[str, str]:
        env = os.environ.copy()
        session_root = CodeExecutorTool._resolve_session_working_root(runtime_context)
        python_paths: list[str] = []
        if session_root is not None:
            python_paths.append(str(session_root))
            skills_root = session_root / "skills"
            if skills_root.exists() and skills_root.is_dir():
                for child in skills_root.iterdir():
                    if not child.is_dir():
                        continue
                    scripts_dir = child / "scripts"
                    if scripts_dir.exists() and scripts_dir.is_dir():
                        python_paths.append(str(scripts_dir))
        existing = str(env.get("PYTHONPATH") or "").strip()
        existing_parts = [part for part in existing.split(os.pathsep) if part] if existing else []
        merged: list[str] = []
        for part in [*python_paths, *existing_parts]:
            normalized = str(part).strip()
            if normalized and normalized not in merged:
                merged.append(normalized)
        if merged:
            env["PYTHONPATH"] = os.pathsep.join(merged)
        return env

    async def execute(
        self,
        language: str,
        code: str,
        stdin: str | None = None,
        workdir: str | None = None,
        timeout_ms: int | None = None,
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
        # LLMs sometimes produce code with literal escaped newlines (\\n)
        # instead of real newline characters, causing SyntaxError.
        # Detect and fix: if the code has no real newlines but contains \\n,
        # it's a single-line string that needs unescaping.
        if "\n" not in code and "\\n" in code:
            code = code.replace("\\n", "\n").replace("\\t", "\t")

        if language not in self.allowed_languages:
            return ToolResult.error_result(
                f"Language '{language}' not allowed. Allowed: {self.allowed_languages}"
            )

        try:
            if language == "python":
                return await self._execute_python(code, stdin, kwargs.get("_runtime_context"), timeout_ms=timeout_ms)
            elif language == "javascript":
                return await self._execute_javascript(code, stdin, kwargs.get("_runtime_context"), timeout_ms=timeout_ms)
            elif language == "shell":
                return await self._execute_shell(code, stdin, kwargs.get("_runtime_context"), workdir=workdir, timeout_ms=timeout_ms)
            else:
                return ToolResult.error_result(f"Unknown language: {language}")

        except asyncio.TimeoutError:
            return ToolResult.error_result(
                f"Execution timed out after {self.timeout} seconds"
            )
        except Exception as e:
            logger.error(f"Code execution failed: {e}")
            return ToolResult.error_result(f"Execution failed: {str(e)}")

    # Preamble injected before user code to patch common fpdf2 issues.
    # Registers bold/italic variants of the Chinese font so style='B'/'I' won't crash.
    _PYTHON_PREAMBLE = '''\
try:
    import fpdf as _fpdf_orig
    _OrigFPDF = _fpdf_orig.FPDF
    class _PatchedFPDF(_OrigFPDF):
        _cjk_font_registered = set()
        def add_font(self, family="", style="", fname="", *a, **kw):
            super().add_font(family, style, fname, *a, **kw)
            key = family.lower()
            if fname and fname.endswith((".ttc", ".ttf")) and key not in self._cjk_font_registered:
                self._cjk_font_registered.add(key)
                for s in ("B", "I", "BI"):
                    try:
                        super().add_font(family, s, fname)
                    except Exception:
                        pass
        def multi_cell(self, w=0, h=None, text="", *a, **kw):
            # Safety: if w=0 and remaining horizontal space is too narrow, wrap to next line
            if w == 0:
                if self.w - self.r_margin - self.x < 10:
                    self.ln()
                    self.x = self.l_margin
            super().multi_cell(w, h, text=text, *a, **kw)
    _fpdf_orig.FPDF = _PatchedFPDF
except ImportError:
    pass
'''

    # ── Auto-install helpers ──────────────────────────────────────────

    _RE_PYTHON_MISSING = re.compile(r"No module named ['\"]([^'\"]+)['\"]")
    _RE_JS_MISSING = re.compile(r"Cannot find (?:module|package) ['\"]([^'\"]+)['\"]")

    # Map common module names to pip package names when they differ
    _PYTHON_MODULE_TO_PACKAGE: dict[str, str] = {
        "pptx": "python-pptx",
        "docx": "python-docx",
        "PIL": "Pillow",
        "cv2": "opencv-python",
        "yaml": "PyYAML",
        "bs4": "beautifulsoup4",
        "sklearn": "scikit-learn",
        "markitdown": "markitdown[pptx]",
    }

    @staticmethod
    def _detect_missing_python_module(result: ToolResult) -> str | None:
        """Parse stderr for ModuleNotFoundError and return the missing module name."""
        if result.success:
            return None
        stderr = ""
        if isinstance(result.result, dict):
            stderr = result.result.get("stderr", "")
        match = CodeExecutorTool._RE_PYTHON_MISSING.search(stderr)
        if match:
            return match.group(1).split(".")[0]
        return None

    @staticmethod
    def _detect_missing_js_module(result: ToolResult) -> str | None:
        """Parse stderr for missing Node.js module."""
        if result.success:
            return None
        stderr = ""
        if isinstance(result.result, dict):
            stderr = result.result.get("stderr", "")
        match = CodeExecutorTool._RE_JS_MISSING.search(stderr)
        if match:
            return match.group(1).split("/")[0]
        return None

    @staticmethod
    async def _auto_install_python(module_name: str) -> bool:
        """Attempt to pip-install a missing Python package. Returns True on success."""
        package = CodeExecutorTool._PYTHON_MODULE_TO_PACKAGE.get(module_name, module_name)
        logger.info("auto_installed_python_dep: attempting pip install %s (module: %s)", package, module_name)
        try:
            proc = await asyncio.create_subprocess_exec(
                sys.executable, "-m", "pip", "install", "--quiet", package,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            _, stderr = await asyncio.wait_for(proc.communicate(), timeout=120)
            if proc.returncode == 0:
                logger.info("auto_installed_python_dep: successfully installed %s", package)
                return True
            logger.warning("auto_installed_python_dep: pip install %s failed (exit %s): %s", package, proc.returncode, stderr.decode(errors="replace"))
        except Exception as exc:
            logger.warning("auto_installed_python_dep: pip install %s error: %s", package, exc)
        return False

    @staticmethod
    async def _auto_install_js_global(module_name: str) -> bool:
        """Attempt to npm install -g a missing JS package. Returns True on success."""
        logger.info("auto_installed_js_dep: attempting npm install -g %s", module_name)
        try:
            proc = await asyncio.create_subprocess_exec(
                "npm", "install", "-g", module_name,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            _, stderr = await asyncio.wait_for(proc.communicate(), timeout=120)
            if proc.returncode == 0:
                logger.info("auto_installed_js_dep: successfully installed %s", module_name)
                return True
            logger.warning("auto_installed_js_dep: npm install -g %s failed (exit %s): %s", module_name, proc.returncode, stderr.decode(errors="replace"))
        except Exception as exc:
            logger.warning("auto_installed_js_dep: npm install -g %s error: %s", module_name, exc)
        return False

    # ── End auto-install helpers ──────────────────────────────────────

    async def _execute_python(
        self,
        code: str,
        stdin: str | None = None,
        runtime_context: Any | None = None,
        timeout_ms: int | None = None,
    ) -> ToolResult:
        """Execute Python code."""
        tmpdir = self._create_work_dir(runtime_context, "code_executor_py_")

        # Inject preamble to patch common fpdf2 issues
        full_code = self._PYTHON_PREAMBLE + code
        script_path = Path(tmpdir) / "script.py"
        script_path.write_text(full_code)

        result = await self._run_process(
            [sys.executable, str(script_path)],
            stdin=stdin,
            cwd=tmpdir,
            env=self._build_process_env(runtime_context),
            timeout_ms=timeout_ms,
        )

        # Auto-install missing Python module and retry once
        if not result.success:
            missing = self._detect_missing_python_module(result)
            if missing:
                installed = await self._auto_install_python(missing)
                if installed:
                    result = await self._run_process(
                        [sys.executable, str(script_path)],
                        stdin=stdin,
                        cwd=tmpdir,
                        env=self._build_process_env(runtime_context),
                        timeout_ms=timeout_ms,
                    )

        if not result.success:
            logger.error(
                "Python execution failed (exit_code=%s)\n--- CODE ---\n%s\n--- STDERR ---\n%s",
                result.result.get("exit_code") if isinstance(result.result, dict) else "?",
                code,
                result.result.get("stderr", "") if isinstance(result.result, dict) else "",
            )

        generated_files = self._collect_output_files(tmpdir, {"script.py"})
        if generated_files:
            result.metadata["generated_files"] = generated_files
        result.metadata["work_dir"] = tmpdir

        return result

    async def _execute_javascript(
        self,
        code: str,
        stdin: str | None = None,
        runtime_context: Any | None = None,
        timeout_ms: int | None = None,
    ) -> ToolResult:
        """Execute JavaScript code with Node.js."""
        tmpdir = self._create_work_dir(runtime_context, "code_executor_js_")

        script_path = Path(tmpdir) / "script.js"
        script_path.write_text(code)

        result = await self._run_process(
            ["node", str(script_path)],
            stdin=stdin,
            cwd=tmpdir,
            env=self._build_process_env(runtime_context),
            timeout_ms=timeout_ms,
        )

        # Auto-install missing JS module and retry once
        if not result.success:
            missing = self._detect_missing_js_module(result)
            if missing:
                installed = await self._auto_install_js_global(missing)
                if installed:
                    result = await self._run_process(
                        ["node", str(script_path)],
                        stdin=stdin,
                        cwd=tmpdir,
                        env=self._build_process_env(runtime_context),
                        timeout_ms=timeout_ms,
                    )

        generated_files = self._collect_output_files(tmpdir, {"script.js"})
        if generated_files:
            result.metadata["generated_files"] = generated_files
        result.metadata["work_dir"] = tmpdir

        return result

    async def _execute_shell(
        self,
        code: str,
        stdin: str | None = None,
        runtime_context: Any | None = None,
        workdir: str | None = None,
        timeout_ms: int | None = None,
    ) -> ToolResult:
        """Execute shell script."""
        shell_dir = self._resolve_shell_work_dir(runtime_context, workdir)
        before_snapshot = self._snapshot_work_dir(shell_dir)

        result = await self._run_process(
            ["bash", "-lc", code],
            stdin=stdin,
            cwd=str(shell_dir),
            env=self._build_process_env(runtime_context),
            timeout_ms=timeout_ms,
        )

        generated_files = self._collect_changed_output_files(shell_dir, before_snapshot)
        if generated_files:
            result.metadata["generated_files"] = generated_files
        result.metadata["work_dir"] = str(shell_dir)

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
                meta["source_path"] = str(entry.resolve())
                lower_name = entry.name.lower()
                lower_ext = entry.suffix.lower()
                meta["artifact_role"] = _infer_artifact_role(entry)
                meta.update(_infer_artifact_semantics(entry, str(meta.get("artifact_role") or "")))
                # JSON files emitted by code execution are usually structured intermediate data
                # for downstream synthesis, not end-user deliverables.
                if lower_ext == ".json":
                    meta["user_visible"] = False
                else:
                    meta["user_visible"] = not any(
                        token in lower_name for token in ("plan", "context", "state", "debug", "tmp")
                    )
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

    def _collect_changed_output_files(
        self,
        work_dir: Path,
        before_snapshot: dict[str, tuple[int, int]],
    ) -> list[dict[str, Any]]:
        if _file_manager is None:
            logger.debug("FileManager not available, skipping changed file collection")
            return []

        collected: list[dict[str, Any]] = []
        for entry in work_dir.rglob("*"):
            if not entry.is_file():
                continue
            try:
                stat = entry.stat()
            except Exception:
                continue
            resolved = str(entry.resolve())
            current = (int(stat.st_mtime_ns), int(stat.st_size))
            if before_snapshot.get(resolved) == current:
                continue

            meta = _file_manager.persist_file(entry)
            if meta is None:
                continue
            meta["source_path"] = resolved
            lower_name = entry.name.lower()
            lower_ext = entry.suffix.lower()
            meta["artifact_role"] = _infer_artifact_role(entry)
            meta.update(_infer_artifact_semantics(entry, str(meta.get("artifact_role") or "")))
            if lower_ext == ".json":
                meta["user_visible"] = False
            else:
                meta["user_visible"] = not any(
                    token in lower_name for token in ("plan", "context", "state", "debug", "tmp")
                )
            collected.append(meta)
        return collected

    async def _run_process(
        self,
        cmd: list[str],
        stdin: str | None = None,
        cwd: str | None = None,
        env: dict[str, str] | None = None,
        timeout_ms: int | None = None,
    ) -> ToolResult:
        """Run a subprocess with timeout."""
        try:
            process = await asyncio.create_subprocess_exec(
                *cmd,
                stdin=subprocess.PIPE if stdin else None,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                cwd=cwd,
                env=env,
            )

            timeout_seconds = (
                max(0.1, float(timeout_ms) / 1000.0)
                if isinstance(timeout_ms, int) and timeout_ms > 0
                else self.timeout
            )
            stdout_bytes, stderr_bytes = await asyncio.wait_for(
                process.communicate(input=stdin.encode() if stdin else None),
                timeout=timeout_seconds,
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
