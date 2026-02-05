"""Validation utilities for input parameter checking."""

from __future__ import annotations

import uuid
from typing import Any

from src.utils.logging import get_logger

logger = get_logger(__name__)


class InvalidInputError(ValueError):
    """Invalid input parameter error.

    Raised when input validation fails. Provides clear error messages
    for debugging and API responses.
    """

    pass


class MemoryConnectionError(Exception):
    """Memory system connection error.

    Raised when connection to Redis or PostgreSQL fails after retries.
    """

    pass


def validate_uuid(value: str | None, field_name: str = "id") -> uuid.UUID:
    """
    Validate and convert a UUID string.

    Args:
        value: UUID string to validate
        field_name: Field name for error messages

    Returns:
        uuid.UUID object

    Raises:
        InvalidInputError: If value is empty or invalid UUID format
    """
    if not value:
        raise InvalidInputError(f"{field_name} cannot be empty")

    if not isinstance(value, str):
        raise InvalidInputError(
            f"{field_name} must be a string, got {type(value).__name__}"
        )

    try:
        return uuid.UUID(value)
    except ValueError as e:
        raise InvalidInputError(
            f"Invalid UUID format for {field_name}: {value}"
        ) from e


def validate_uuid_optional(
    value: str | None, field_name: str = "id"
) -> uuid.UUID | None:
    """
    Validate and convert an optional UUID string.

    Args:
        value: UUID string to validate, or None
        field_name: Field name for error messages

    Returns:
        uuid.UUID object or None

    Raises:
        InvalidInputError: If value is non-empty but invalid UUID format
    """
    if value is None:
        return None

    return validate_uuid(value, field_name)


def validate_content(content: str | None, min_length: int = 1) -> str:
    """
    Validate content is non-empty.

    Args:
        content: Content string to validate
        min_length: Minimum required length after stripping whitespace

    Returns:
        Stripped content string

    Raises:
        InvalidInputError: If content is empty or too short
    """
    if content is None:
        raise InvalidInputError("Content cannot be None")

    if not isinstance(content, str):
        raise InvalidInputError(
            f"Content must be a string, got {type(content).__name__}"
        )

    stripped = content.strip()
    if len(stripped) < min_length:
        raise InvalidInputError(
            f"Content must be at least {min_length} characters, got {len(stripped)}"
        )

    return stripped


def validate_positive_int(
    value: int | None,
    field_name: str = "value",
    default: int | None = None,
    max_value: int | None = None,
) -> int:
    """
    Validate that a value is a positive integer.

    Args:
        value: Value to validate
        field_name: Field name for error messages
        default: Default value if None
        max_value: Optional maximum value

    Returns:
        Validated positive integer

    Raises:
        InvalidInputError: If value is not a positive integer
    """
    if value is None:
        if default is not None:
            return default
        raise InvalidInputError(f"{field_name} cannot be None")

    if not isinstance(value, int) or isinstance(value, bool):
        raise InvalidInputError(
            f"{field_name} must be an integer, got {type(value).__name__}"
        )

    if value <= 0:
        raise InvalidInputError(f"{field_name} must be positive, got {value}")

    if max_value is not None and value > max_value:
        logger.warning(
            "value_exceeds_maximum",
            field=field_name,
            value=value,
            max_value=max_value,
        )
        return max_value

    return value


def validate_float_range(
    value: float | int | None,
    field_name: str = "value",
    min_value: float = 0.0,
    max_value: float = 1.0,
    default: float | None = None,
) -> float:
    """
    Validate that a value is within a float range.

    Args:
        value: Value to validate
        field_name: Field name for error messages
        min_value: Minimum allowed value
        max_value: Maximum allowed value
        default: Default value if None

    Returns:
        Validated float clamped to range

    Raises:
        InvalidInputError: If value is not a number
    """
    if value is None:
        if default is not None:
            return default
        raise InvalidInputError(f"{field_name} cannot be None")

    if not isinstance(value, (int, float)) or isinstance(value, bool):
        raise InvalidInputError(
            f"{field_name} must be a number, got {type(value).__name__}"
        )

    # Clamp to range instead of raising error
    clamped = max(min_value, min(max_value, float(value)))

    if clamped != value:
        logger.debug(
            "value_clamped_to_range",
            field=field_name,
            original=value,
            clamped=clamped,
            min_value=min_value,
            max_value=max_value,
        )

    return clamped
