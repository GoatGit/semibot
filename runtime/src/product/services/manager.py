from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Any

from .model import ServiceDefinition


class ServiceManager(ABC):
    """Abstract lifecycle contract for install-mode service supervision."""

    @abstractmethod
    def start(self, definition: ServiceDefinition | None = None) -> dict[str, Any]:
        raise NotImplementedError

    @abstractmethod
    def stop(self, definition: ServiceDefinition | None = None) -> dict[str, Any]:
        raise NotImplementedError

    @abstractmethod
    def status(self, definition: ServiceDefinition | None = None) -> dict[str, Any]:
        raise NotImplementedError
