"""Tests for per-role model configuration (NodeModelConfig / ModelRoleConfig).

Covers:
- AgentConfig.model_roles defaults
- _parse_node_model_config / _parse_model_roles helpers in semigraph_adapter
- Model and temperature resolution priority in PLAN / ACT / RESPOND / text_processing
"""

import pytest
from src.orchestrator.context import AgentConfig, ModelRoleConfig, NodeModelConfig
from src.orchestrator.context import parse_node_model_config as _parse_node_model_config
from src.orchestrator.context import parse_model_roles as _parse_model_roles


def test_agent_config_model_roles_default():
    """model_roles should default to empty NodeModelConfig for each role."""
    cfg = AgentConfig(id="a1", name="Test")
    assert isinstance(cfg.model_roles, ModelRoleConfig)
    assert cfg.model_roles.plan.model is None
    assert cfg.model_roles.plan.temperature is None
    assert cfg.model_roles.act.model is None
    assert cfg.model_roles.act.temperature is None
    assert cfg.model_roles.text_processing.model is None
    assert cfg.model_roles.text_processing.temperature is None


def test_agent_config_model_roles_explicit():
    """Explicit model_roles values should be stored correctly."""
    roles = ModelRoleConfig(
        plan=NodeModelConfig(model="claude-opus-4-6", temperature=0.1),
        act=NodeModelConfig(model="claude-sonnet-4-6", temperature=0.3),
        text_processing=NodeModelConfig(model="claude-haiku-4-5", temperature=0.0),
    )
    cfg = AgentConfig(id="a1", name="Test", model="gpt-4o", model_roles=roles)
    assert cfg.model_roles.plan.model == "claude-opus-4-6"
    assert cfg.model_roles.plan.temperature == 0.1
    assert cfg.model_roles.act.model == "claude-sonnet-4-6"
    assert cfg.model_roles.act.temperature == 0.3
    assert cfg.model_roles.text_processing.model == "claude-haiku-4-5"
    assert cfg.model_roles.text_processing.temperature == 0.0


# ---------------------------------------------------------------------------
# _parse_node_model_config
# ---------------------------------------------------------------------------


class TestParseNodeModelConfig:
    def test_none_input(self):
        result = _parse_node_model_config(None)
        assert result.model is None
        assert result.temperature is None

    def test_empty_dict(self):
        result = _parse_node_model_config({})
        assert result.model is None
        assert result.temperature is None

    def test_model_only(self):
        result = _parse_node_model_config({"model": "gpt-4o"})
        assert result.model == "gpt-4o"
        assert result.temperature is None

    def test_temperature_only(self):
        result = _parse_node_model_config({"temperature": 0.5})
        assert result.model is None
        assert result.temperature == 0.5

    def test_both_fields(self):
        result = _parse_node_model_config({"model": "claude-sonnet-4-6", "temperature": 0.2})
        assert result.model == "claude-sonnet-4-6"
        assert result.temperature == 0.2

    def test_temperature_as_int(self):
        result = _parse_node_model_config({"temperature": 0})
        assert result.temperature == 0.0

    def test_empty_model_string_becomes_none(self):
        result = _parse_node_model_config({"model": "   "})
        assert result.model is None

    def test_non_dict_input(self):
        result = _parse_node_model_config("invalid")
        assert result.model is None
        assert result.temperature is None


# ---------------------------------------------------------------------------
# _parse_model_roles
# ---------------------------------------------------------------------------


class TestParseModelRoles:
    def test_none_input(self):
        result = _parse_model_roles(None)
        assert isinstance(result, ModelRoleConfig)
        assert result.plan.model is None
        assert result.act.model is None
        assert result.text_processing.model is None

    def test_empty_dict(self):
        result = _parse_model_roles({})
        assert result.plan.model is None
        assert result.act.model is None
        assert result.text_processing.model is None

    def test_full_config(self):
        raw = {
            "plan": {"model": "claude-opus-4-6", "temperature": 0.1},
            "act": {"model": "claude-sonnet-4-6", "temperature": 0.2},
            "textProcessing": {"model": "claude-haiku-4-5", "temperature": 0.0},
        }
        result = _parse_model_roles(raw)
        assert result.plan.model == "claude-opus-4-6"
        assert result.plan.temperature == 0.1
        assert result.act.model == "claude-sonnet-4-6"
        assert result.act.temperature == 0.2
        assert result.text_processing.model == "claude-haiku-4-5"
        assert result.text_processing.temperature == 0.0

    def test_snake_case_text_processing_key(self):
        """text_processing key (snake_case) should also be accepted."""
        raw = {"text_processing": {"model": "claude-haiku-4-5"}}
        result = _parse_model_roles(raw)
        assert result.text_processing.model == "claude-haiku-4-5"

    def test_camel_case_takes_precedence_over_snake_case(self):
        """textProcessing (camelCase) takes precedence when both keys present."""
        raw = {
            "textProcessing": {"model": "camel-model"},
            "text_processing": {"model": "snake-model"},
        }
        result = _parse_model_roles(raw)
        assert result.text_processing.model == "camel-model"

    def test_partial_config(self):
        """Only plan configured; act and text_processing should be empty."""
        raw = {"plan": {"model": "gpt-4o"}}
        result = _parse_model_roles(raw)
        assert result.plan.model == "gpt-4o"
        assert result.act.model is None
        assert result.text_processing.model is None


# ---------------------------------------------------------------------------
# Model resolution priority helpers
# ---------------------------------------------------------------------------


def _resolve_model(role_cfg: NodeModelConfig, global_model: str | None) -> str | None:
    """Mirrors the resolution logic used in nodes_plan / nodes_act."""
    return role_cfg.model or global_model or None


def _resolve_temperature(role_cfg: NodeModelConfig, node_default: float) -> float:
    """Mirrors the resolution logic used in nodes_plan / nodes_act."""
    return role_cfg.temperature if role_cfg.temperature is not None else node_default


class TestModelResolutionPriority:
    def test_role_model_overrides_global(self):
        role_cfg = NodeModelConfig(model="role-model")
        assert _resolve_model(role_cfg, "global-model") == "role-model"

    def test_global_model_used_when_role_empty(self):
        role_cfg = NodeModelConfig()
        assert _resolve_model(role_cfg, "global-model") == "global-model"

    def test_none_when_both_empty(self):
        role_cfg = NodeModelConfig()
        assert _resolve_model(role_cfg, None) is None

    def test_role_temperature_overrides_default(self):
        role_cfg = NodeModelConfig(temperature=0.9)
        assert _resolve_temperature(role_cfg, 0.2) == 0.9

    def test_zero_temperature_is_valid_override(self):
        """temperature=0 must not fall back to node default."""
        role_cfg = NodeModelConfig(temperature=0.0)
        assert _resolve_temperature(role_cfg, 0.2) == 0.0

    def test_node_default_used_when_role_temperature_none(self):
        role_cfg = NodeModelConfig()
        assert _resolve_temperature(role_cfg, 0.2) == 0.2
