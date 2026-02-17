"""Enhanced evolution safety checker with whitelist support."""

from dataclasses import dataclass, field
from src.utils.logging import get_logger

logger = get_logger(__name__)

# 危险操作模式
DANGEROUS_ACTION_PATTERNS = [
    "rm -rf", "DROP TABLE", "DELETE FROM", "TRUNCATE TABLE",
    "os.system", "subprocess.run", "subprocess.call",
    "eval(", "exec(", "__import__",
    "shutil.rmtree", "os.remove", "os.unlink",
]

# 需要白名单的敏感操作
SENSITIVE_OPERATIONS = [
    "send_email", "send_notification",
    "external_api_call", "webhook_trigger",
    "file_write", "database_write",
]

# 危险工具黑名单
DANGEROUS_TOOLS = [
    "shell_exec", "file_delete", "database_drop",
    "system_command", "raw_sql",
]


@dataclass
class SafetyResult:
    """安全检查结果"""
    is_safe: bool
    reason: str = ""
    warnings: list[str] = field(default_factory=list)


class EvolutionSafetyChecker:
    """增强版进化技能安全检查器（支持白名单）"""

    def __init__(self, whitelist: list[str] | None = None):
        self.whitelist = set(whitelist or [])

    def check(self, draft) -> SafetyResult:
        """全面安全检查"""
        warnings: list[str] = []

        # 1. 检查步骤中的危险模式
        for step in draft.steps:
            action = str(step.get("action", ""))
            params = str(step.get("params_template", {}))
            combined = f"{action} {params}"

            for pattern in DANGEROUS_ACTION_PATTERNS:
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

        # 3. 检查敏感操作（需白名单）
        for step in draft.steps:
            tool = step.get("tool", "")
            action = step.get("action", "")
            for sensitive_op in SENSITIVE_OPERATIONS:
                if sensitive_op in tool or sensitive_op in action:
                    if sensitive_op not in self.whitelist:
                        warnings.append(
                            f"包含敏感操作 '{sensitive_op}'，建议人工审核"
                        )

        # 4. 检查参数注入风险
        for param_name, param_def in draft.parameters.items():
            if isinstance(param_def, dict):
                param_type = param_def.get("type", "")
                if param_type not in ("string", "number", "boolean", "array", "object"):
                    return SafetyResult(
                        is_safe=False,
                        reason=f"参数 '{param_name}' 类型不合法: {param_type}",
                    )

        return SafetyResult(is_safe=True, warnings=warnings)
