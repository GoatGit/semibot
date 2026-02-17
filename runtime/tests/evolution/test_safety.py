"""SafetyChecker tests."""

import pytest
from src.evolution.validators import SafetyChecker, SafetyResult
from src.evolution.models import SkillDraft


class TestSafetyChecker:
    """安全检查器测试"""

    @pytest.fixture
    def checker(self):
        return SafetyChecker()

    def _make_draft(self, steps=None, tools_used=None, parameters=None):
        return SkillDraft(
            name="test",
            description="test",
            steps=steps or [{"order": 1, "action": "safe", "tool": "query"}],
            tools_used=tools_used or ["query"],
            parameters=parameters or {},
        )

    def test_safe_skill(self, checker):
        draft = self._make_draft(
            steps=[{"order": 1, "action": "查询数据", "tool": "query", "params_template": {}}],
            tools_used=["query"],
        )
        result = checker.check(draft)
        assert result.is_safe is True

    def test_dangerous_rm_rf(self, checker):
        draft = self._make_draft(
            steps=[{"order": 1, "action": "rm -rf /tmp", "tool": "shell"}],
            tools_used=["shell"],
        )
        result = checker.check(draft)
        assert result.is_safe is False
        assert "rm -rf" in result.reason

    def test_dangerous_drop_table(self, checker):
        draft = self._make_draft(
            steps=[{"order": 1, "action": "DROP TABLE users", "tool": "sql"}],
            tools_used=["sql"],
        )
        result = checker.check(draft)
        assert result.is_safe is False

    def test_dangerous_eval(self, checker):
        draft = self._make_draft(
            steps=[{"order": 1, "action": "eval(user_input)", "tool": "exec"}],
            tools_used=["exec"],
        )
        result = checker.check(draft)
        assert result.is_safe is False

    def test_dangerous_tool_shell_exec(self, checker):
        draft = self._make_draft(
            steps=[{"order": 1, "action": "执行", "tool": "shell_exec"}],
            tools_used=["shell_exec"],
        )
        result = checker.check(draft)
        assert result.is_safe is False

    def test_dangerous_os_system(self, checker):
        draft = self._make_draft(
            steps=[{"order": 1, "action": "os.system('ls')", "tool": "py"}],
            tools_used=["py"],
        )
        result = checker.check(draft)
        assert result.is_safe is False

    def test_dangerous_subprocess(self, checker):
        draft = self._make_draft(
            steps=[{"order": 1, "action": "subprocess.run(['ls'])", "tool": "py"}],
            tools_used=["py"],
        )
        result = checker.check(draft)
        assert result.is_safe is False

    def test_dangerous_exec(self, checker):
        draft = self._make_draft(
            steps=[{"order": 1, "action": "exec(code)", "tool": "py"}],
            tools_used=["py"],
        )
        result = checker.check(draft)
        assert result.is_safe is False

    def test_dangerous_tool_raw_sql(self, checker):
        draft = self._make_draft(
            steps=[{"order": 1, "action": "query", "tool": "raw_sql"}],
            tools_used=["raw_sql"],
        )
        result = checker.check(draft)
        assert result.is_safe is False

    def test_invalid_param_type(self, checker):
        draft = self._make_draft(
            parameters={"cmd": {"type": "executable", "description": "命令"}},
        )
        result = checker.check(draft)
        assert result.is_safe is False
        assert "类型不合法" in result.reason

    def test_valid_param_types(self, checker):
        draft = self._make_draft(
            parameters={
                "name": {"type": "string"},
                "count": {"type": "number"},
                "flag": {"type": "boolean"},
                "items": {"type": "array"},
                "config": {"type": "object"},
            },
        )
        result = checker.check(draft)
        assert result.is_safe is True

    def test_params_template_injection(self, checker):
        draft = self._make_draft(
            steps=[{"order": 1, "action": "query", "tool": "db", "params_template": "rm -rf /"}],
        )
        result = checker.check(draft)
        assert result.is_safe is False
