"""Evolution safety validators."""

from dataclasses import dataclass, field
from src.utils.logging import get_logger

logger = get_logger(__name__)

DANGEROUS_PATTERNS = [
    "rm -rf",
    "DROP TABLE",
    "DELETE FROM",
    "TRUNCATE",
    "os.system",
    "subprocess",
    "eval(",
    "exec(",
    "format(",
    "__import__",
    "shutil.rmtree",
    "os.remove",
    "os.unlink",
]

DANGEROUS_TOOLS = [
    "shell_exec",
    "file_delete",
    "database_drop",
    "system_command",
    "raw_sql",
]


@dataclass
class SafetyResult:
    """安全检查结果"""

    is_safe: bool
    reason: str = ""
    warnings: list[str] = field(default_factory=list)


class SafetyChecker:
    """技能安全检查器"""

    def check(self, draft) -> SafetyResult:
        """检查技能草稿的安全性"""
        warnings: list[str] = []

        # 1. 检查步骤中的危险模式
        for step in draft.steps:
            action = str(step.get("action", ""))
            params = str(step.get("params_template", {}))
            combined = f"{action} {params}"

            for pattern in DANGEROUS_PATTERNS:
                if pattern.lower() in combined.lower():
                    return SafetyResult(
                        is_safe=False,
                        reason=f"步骤包含危险操作: {pattern}",
                    )

        # 2. 检查危险工具
        for tool in draft.tools_used:
            if tool in DANGEROUS_TOOLS:
                return SafetyResult(
                    is_safe=False,
                    reason=f"使用了危险工具: {tool}",
                )

        # 3. 检查参数类型合法性
        for param_name, param_def in draft.parameters.items():
            if isinstance(param_def, dict):
                param_type = param_def.get("type", "")
                if param_type not in ("string", "number", "boolean", "array", "object"):
                    return SafetyResult(
                        is_safe=False,
                        reason=f"参数 '{param_name}' 类型不合法: {param_type}",
                    )

        return SafetyResult(is_safe=True, warnings=warnings)
