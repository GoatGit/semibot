from __future__ import annotations

import base64
import hashlib
from typing import Any

import pytest
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from src.session.manager import SessionManager
from src.session.runtime_adapter import RuntimeAdapter


class DummyClient:
    def set_active_sessions_provider(self, _provider):  # noqa: ANN001
        return None

    def register_session_handlers(self, _session_id: str, user_message, cancel):  # noqa: ANN001
        self._user_message = user_message
        self._cancel = cancel

    def unregister_session_handlers(self, _session_id: str):
        return None


class DummyAdapter(RuntimeAdapter):
    async def start(self) -> None:
        return None

    async def handle_user_message(self, payload: dict[str, Any]) -> None:
        del payload
        return None

    async def cancel(self) -> None:
        return None

    async def stop(self) -> None:
        return None


@pytest.mark.asyncio
async def test_start_session_filters_skills_by_requirements(monkeypatch):
    client = DummyClient()
    manager = SessionManager(client=client, init_data={"user_id": "u1", "org_id": "o1"})
    captured: dict[str, Any] = {}

    def fake_create_adapter(runtime_type: str, session_id: str, data: dict[str, Any]) -> RuntimeAdapter:
        captured["runtime_type"] = runtime_type
        captured["session_id"] = session_id
        captured["data"] = data
        return DummyAdapter()

    monkeypatch.setattr(manager, "_create_adapter", fake_create_adapter)

    await manager.start_session(
        {
            "session_id": "sess-1",
            "runtime_type": "semigraph",
            "skill_index": [
                {
                    "id": "skill-missing-bin",
                    "requires": {"binaries": ["definitely-missing-binary"], "env_vars": []},
                },
                {
                    "id": "skill-missing-env",
                    "requires": {"binaries": [], "env_vars": ["DEFINITELY_MISSING_ENV"]},
                },
                {
                    "id": "skill-ok",
                    "requires": {"binaries": [], "env_vars": []},
                },
            ],
        }
    )

    filtered = captured["data"]["skill_index"]
    assert [skill["id"] for skill in filtered] == ["skill-ok"]


def _encrypt_secret(secret: str, vm_token: str) -> dict[str, str]:
    key = hashlib.sha256(f"semibot:init:{vm_token}".encode("utf-8")).digest()
    aesgcm = AESGCM(key)
    iv = b"123456789012"
    encrypted = aesgcm.encrypt(iv, secret.encode("utf-8"), b"semibot:init:api_keys")
    return {
        "alg": "aes-256-gcm",
        "iv": base64.b64encode(iv).decode("utf-8"),
        "ciphertext": base64.b64encode(encrypted[:-16]).decode("utf-8"),
        "tag": base64.b64encode(encrypted[-16:]).decode("utf-8"),
    }


def test_session_manager_decrypts_init_api_keys(monkeypatch):
    vm_token = "jwt-token-for-vm"
    monkeypatch.setenv("VM_TOKEN", vm_token)
    encrypted_openai = _encrypt_secret("sk-openai-plain", vm_token)

    manager = SessionManager(
        client=DummyClient(),
        init_data={
            "user_id": "u1",
            "org_id": "o1",
            "api_keys": {"openai": encrypted_openai},
        },
    )

    assert manager.init_data["api_keys"]["openai"] == "sk-openai-plain"
