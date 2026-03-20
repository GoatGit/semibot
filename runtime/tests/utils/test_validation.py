"""Unit tests for validation utilities."""

from __future__ import annotations

import importlib.util
import sys
import uuid
from pathlib import Path
from unittest.mock import MagicMock

import pytest

# Mock the logging module before importing validation
mock_logger = MagicMock()
mock_logger.get_logger = MagicMock(return_value=MagicMock())
sys.modules['src.utils.logging'] = mock_logger

# Load validation module directly to avoid import chain issues
validation_path = Path(__file__).parent.parent.parent / "src" / "utils" / "validation.py"
spec = importlib.util.spec_from_file_location("validation", validation_path)
validation = importlib.util.module_from_spec(spec)
spec.loader.exec_module(validation)

InvalidInputError = validation.InvalidInputError
validate_content = validation.validate_content
validate_float_range = validation.validate_float_range
validate_positive_int = validation.validate_positive_int
validate_uuid = validation.validate_uuid
validate_uuid_optional = validation.validate_uuid_optional


class TestValidateUuid:
    """Tests for validate_uuid function."""

    def test_valid_uuid_string(self):
        """Test valid UUID string is converted."""
        uuid_str = "550e8400-e29b-41d4-a716-446655440000"
        result = validate_uuid(uuid_str, "test_id")
        assert isinstance(result, uuid.UUID)
        assert str(result) == uuid_str

    def test_valid_uuid_uppercase(self):
        """Test uppercase UUID string is accepted."""
        uuid_str = "550E8400-E29B-41D4-A716-446655440000"
        result = validate_uuid(uuid_str, "test_id")
        assert isinstance(result, uuid.UUID)

    def test_valid_uuid_no_hyphens(self):
        """Test UUID without hyphens is accepted."""
        uuid_str = "550e8400e29b41d4a716446655440000"
        result = validate_uuid(uuid_str, "test_id")
        assert isinstance(result, uuid.UUID)

    def test_empty_string_raises_error(self):
        """Test empty string raises InvalidInputError."""
        with pytest.raises(InvalidInputError) as exc_info:
            validate_uuid("", "agent_id")
        assert "agent_id cannot be empty" in str(exc_info.value)

    def test_none_raises_error(self):
        """Test None raises InvalidInputError."""
        with pytest.raises(InvalidInputError) as exc_info:
            validate_uuid(None, "agent_id")
        assert "agent_id cannot be empty" in str(exc_info.value)

    def test_invalid_format_raises_error(self):
        """Test invalid format raises InvalidInputError."""
        with pytest.raises(InvalidInputError) as exc_info:
            validate_uuid("not-a-uuid", "entry_id")
        assert "Invalid UUID format for entry_id" in str(exc_info.value)

    def test_non_string_raises_error(self):
        """Test non-string raises InvalidInputError."""
        with pytest.raises(InvalidInputError) as exc_info:
            validate_uuid(12345, "id")
        assert "must be a string" in str(exc_info.value)


class TestValidateUuidOptional:
    """Tests for validate_uuid_optional function."""

    def test_none_returns_none(self):
        """Test None returns None."""
        result = validate_uuid_optional(None, "session_id")
        assert result is None

    def test_valid_uuid_is_converted(self):
        """Test valid UUID string is converted."""
        uuid_str = "550e8400-e29b-41d4-a716-446655440000"
        result = validate_uuid_optional(uuid_str, "session_id")
        assert isinstance(result, uuid.UUID)
        assert str(result) == uuid_str

    def test_empty_string_raises_error(self):
        """Test empty string raises InvalidInputError (not None)."""
        with pytest.raises(InvalidInputError):
            validate_uuid_optional("", "session_id")

    def test_invalid_format_raises_error(self):
        """Test invalid format raises InvalidInputError."""
        with pytest.raises(InvalidInputError):
            validate_uuid_optional("invalid", "session_id")


class TestValidateContent:
    """Tests for validate_content function."""

    def test_valid_content(self):
        """Test valid content is returned stripped."""
        result = validate_content("  Hello, World!  ", min_length=1)
        assert result == "Hello, World!"

    def test_none_raises_error(self):
        """Test None raises InvalidInputError."""
        with pytest.raises(InvalidInputError) as exc_info:
            validate_content(None)
        assert "cannot be None" in str(exc_info.value)

    def test_empty_string_raises_error(self):
        """Test empty string raises InvalidInputError."""
        with pytest.raises(InvalidInputError) as exc_info:
            validate_content("")
        assert "must be at least" in str(exc_info.value)

    def test_whitespace_only_raises_error(self):
        """Test whitespace-only string raises InvalidInputError."""
        with pytest.raises(InvalidInputError) as exc_info:
            validate_content("   \t\n  ")
        assert "must be at least" in str(exc_info.value)

    def test_min_length_check(self):
        """Test minimum length is enforced."""
        with pytest.raises(InvalidInputError) as exc_info:
            validate_content("Hi", min_length=5)
        assert "must be at least 5 characters" in str(exc_info.value)

    def test_non_string_raises_error(self):
        """Test non-string raises InvalidInputError."""
        with pytest.raises(InvalidInputError) as exc_info:
            validate_content(12345)
        assert "must be a string" in str(exc_info.value)


class TestValidatePositiveInt:
    """Tests for validate_positive_int function."""

    def test_valid_positive_int(self):
        """Test valid positive integer is returned."""
        result = validate_positive_int(10, "limit")
        assert result == 10

    def test_none_with_default(self):
        """Test None with default returns default."""
        result = validate_positive_int(None, "limit", default=5)
        assert result == 5

    def test_none_without_default_raises_error(self):
        """Test None without default raises InvalidInputError."""
        with pytest.raises(InvalidInputError) as exc_info:
            validate_positive_int(None, "limit")
        assert "cannot be None" in str(exc_info.value)

    def test_zero_raises_error(self):
        """Test zero raises InvalidInputError."""
        with pytest.raises(InvalidInputError) as exc_info:
            validate_positive_int(0, "limit")
        assert "must be positive" in str(exc_info.value)

    def test_negative_raises_error(self):
        """Test negative raises InvalidInputError."""
        with pytest.raises(InvalidInputError) as exc_info:
            validate_positive_int(-5, "ttl_seconds")
        assert "must be positive" in str(exc_info.value)

    def test_max_value_clamping(self):
        """Test value is clamped to max_value."""
        result = validate_positive_int(200, "limit", max_value=100)
        assert result == 100

    def test_non_int_raises_error(self):
        """Test non-integer raises InvalidInputError."""
        with pytest.raises(InvalidInputError) as exc_info:
            validate_positive_int("10", "limit")
        assert "must be an integer" in str(exc_info.value)

    def test_bool_raises_error(self):
        """Test boolean raises InvalidInputError (bool is subclass of int)."""
        with pytest.raises(InvalidInputError) as exc_info:
            validate_positive_int(True, "limit")
        assert "must be an integer" in str(exc_info.value)


class TestValidateFloatRange:
    """Tests for validate_float_range function."""

    def test_valid_float_in_range(self):
        """Test valid float in range is returned."""
        result = validate_float_range(0.5, "importance")
        assert result == 0.5

    def test_int_is_converted_to_float(self):
        """Test integer is converted to float."""
        result = validate_float_range(1, "importance")
        assert result == 1.0
        assert isinstance(result, float)

    def test_value_below_min_is_clamped(self):
        """Test value below min is clamped."""
        result = validate_float_range(-0.5, "importance", min_value=0.0)
        assert result == 0.0

    def test_value_above_max_is_clamped(self):
        """Test value above max is clamped."""
        result = validate_float_range(1.5, "importance", max_value=1.0)
        assert result == 1.0

    def test_none_with_default(self):
        """Test None with default returns default."""
        result = validate_float_range(None, "importance", default=0.5)
        assert result == 0.5

    def test_none_without_default_raises_error(self):
        """Test None without default raises InvalidInputError."""
        with pytest.raises(InvalidInputError) as exc_info:
            validate_float_range(None, "importance")
        assert "cannot be None" in str(exc_info.value)

    def test_non_number_raises_error(self):
        """Test non-number raises InvalidInputError."""
        with pytest.raises(InvalidInputError) as exc_info:
            validate_float_range("0.5", "importance")
        assert "must be a number" in str(exc_info.value)

    def test_bool_raises_error(self):
        """Test boolean raises InvalidInputError."""
        with pytest.raises(InvalidInputError) as exc_info:
            validate_float_range(True, "importance")
        assert "must be a number" in str(exc_info.value)

    def test_custom_range(self):
        """Test custom min/max range."""
        result = validate_float_range(50, "score", min_value=0, max_value=100)
        assert result == 50.0

        result_clamped = validate_float_range(150, "score", min_value=0, max_value=100)
        assert result_clamped == 100.0
