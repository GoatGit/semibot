from __future__ import annotations

import base64
import hashlib

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from src.security.api_key_cipher import decrypt_api_keys


def _encrypt(secret: str, token: str) -> dict[str, str]:
    key = hashlib.sha256(f"semibot:init:{token}".encode("utf-8")).digest()
    aesgcm = AESGCM(key)
    iv = b"123456789012"
    encrypted = aesgcm.encrypt(iv, secret.encode("utf-8"), b"semibot:init:api_keys")
    return {
        "alg": "aes-256-gcm",
        "iv": base64.b64encode(iv).decode("utf-8"),
        "ciphertext": base64.b64encode(encrypted[:-16]).decode("utf-8"),
        "tag": base64.b64encode(encrypted[-16:]).decode("utf-8"),
    }


def test_decrypt_api_keys_success() -> None:
    token = "vm-token-1"
    payload = {
        "openai": _encrypt("sk-openai", token),
        "anthropic": _encrypt("sk-anthropic", token),
    }

    decrypted = decrypt_api_keys(payload, token)
    assert decrypted == {
        "openai": "sk-openai",
        "anthropic": "sk-anthropic",
    }


def test_decrypt_api_keys_skips_invalid_payload() -> None:
    decrypted = decrypt_api_keys(
        {
            "openai": {"alg": "unknown"},
            "anthropic": 123,
            "legacy_plain": "sk-plain",
        },
        "token",
    )
    assert decrypted == {"legacy_plain": "sk-plain"}
