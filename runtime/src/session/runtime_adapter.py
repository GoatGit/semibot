from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Any


class RuntimeAdapter(ABC):
    @abstractmethod
    async def start(self) -> None:
        raise NotImplementedError

    @abstractmethod
    async def handle_user_message(self, payload: dict[str, Any]) -> None:
        raise NotImplementedError

    @abstractmethod
    async def cancel(self) -> None:
        raise NotImplementedError

    @abstractmethod
    async def stop(self) -> None:
        raise NotImplementedError

    async def update_config(self, payload: dict[str, Any]) -> None:
        del payload
        return None

    async def get_snapshot(self) -> dict[str, Any] | None:
        return None
