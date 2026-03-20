from __future__ import annotations

import base64
import hashlib
from typing import Any

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from src.utils.logging import get_logger

logger = get_logger(__name__)


def _derive_key(vm_token: str) -> bytes:
    return hashlib.sha256(f"semibot:init:{vm_token}".encode("utf-8")).digest()


def _decrypt_secret(payload: dict[str, Any], vm_token: str) -> str:
    if payload.get("alg") != "aes-256-gcm":
        raise ValueError("unsupported encryption algorithm")

    iv_b64 = payload.get("iv")
    tag_b64 = payload.get("tag")
    ciphertext_b64 = payload.get("ciphertext")
    if not isinstance(iv_b64, str) or not isinstance(tag_b64, str) or not isinstance(ciphertext_b64, str):
        raise ValueError("invalid encrypted secret payload")

    iv = base64.b64decode(iv_b64)
    tag = base64.b64decode(tag_b64)
    ciphertext = base64.b64decode(ciphertext_b64)
    aesgcm = AESGCM(_derive_key(vm_token))
    plaintext = aesgcm.decrypt(iv, ciphertext + tag, b"semibot:init:api_keys")
    return plaintext.decode("utf-8")


def decrypt_api_keys(raw_api_keys: Any, vm_token: str) -> dict[str, str]:
    if not isinstance(raw_api_keys, dict):
        return {}

    decrypted: dict[str, str] = {}
    for provider, value in raw_api_keys.items():
        if not isinstance(provider, str) or not provider.strip():
            continue
        if isinstance(value, str):
            decrypted[provider] = value
            continue
        if not isinstance(value, dict):
            continue
        if not vm_token:
            logger.warning("vm_token_missing_skip_api_key_decrypt", extra={"provider": provider})
            continue
        try:
            decrypted[provider] = _decrypt_secret(value, vm_token)
        except Exception as exc:  # pragma: no cover - defensive logging
            logger.warning(
                "api_key_decrypt_failed_skip_provider",
                extra={"provider": provider, "error": str(exc)},
            )
    return decrypted
