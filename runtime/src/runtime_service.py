"""Runtime execution service facade.

This module is the stable runtime-service entry used by HTTP server handlers.
"""

from __future__ import annotations

from src.local_runtime import run_task_once

__all__ = ["run_task_once"]

