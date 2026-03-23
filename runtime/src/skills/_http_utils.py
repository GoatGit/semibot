"""Shared HTTP utilities for http_client and web_fetch tools."""

from __future__ import annotations

import ipaddress
import socket
from typing import Any
from urllib.parse import urlparse

_LOCAL_BLOCKLIST = {"localhost", "127.0.0.1", "::1", "0.0.0.0"}


def to_bool(value: Any, default: bool = False) -> bool:
    if isinstance(value, bool):
        return value
    if value is None:
        return default
    if isinstance(value, str):
        normalized = value.strip().lower()
        if normalized in {"1", "true", "yes", "on"}:
            return True
        if normalized in {"0", "false", "no", "off"}:
            return False
    return bool(value)


def parse_domain_rules(value: Any) -> list[str]:
    if isinstance(value, str):
        return [item.strip().lower() for item in value.split(",") if item.strip()]
    if isinstance(value, list):
        return [str(item).strip().lower() for item in value if str(item).strip()]
    return []


def host_matches_rule(host: str, rule: str) -> bool:
    normalized_host = host.strip().lower()
    normalized_rule = rule.strip().lower().lstrip(".")
    if not normalized_host or not normalized_rule:
        return False
    return normalized_host == normalized_rule or normalized_host.endswith(f".{normalized_rule}")


def _normalize_host(host: str) -> str:
    return host.strip().lower().rstrip(".")


def _parse_ip_literal(host: str) -> ipaddress._BaseAddress | None:
    normalized = _normalize_host(host)
    if not normalized:
        return None
    try:
        return ipaddress.ip_address(normalized)
    except ValueError:
        pass
    if ":" not in normalized and "." not in normalized:
        try:
            numeric = int(normalized, 0)
        except ValueError:
            return None
        if 0 <= numeric <= (2**32 - 1):
            return ipaddress.IPv4Address(numeric)
    return None


def _is_blocked_ip(address: ipaddress._BaseAddress) -> bool:
    return any(
        (
            address.is_loopback,
            address.is_private,
            address.is_link_local,
            address.is_reserved,
            address.is_unspecified,
            address.is_multicast,
        )
    )


def _resolve_host_ips(host: str) -> list[ipaddress._BaseAddress]:
    try:
        infos = socket.getaddrinfo(host, None, type=socket.SOCK_STREAM)
    except socket.gaierror:
        return []
    addresses: list[ipaddress._BaseAddress] = []
    for info in infos:
        sockaddr = info[4]
        if not sockaddr:
            continue
        candidate = str(sockaddr[0]).strip()
        parsed = _parse_ip_literal(candidate)
        if parsed is not None:
            addresses.append(parsed)
    return addresses


def validate_remote_url(
    raw_url: str,
    *,
    allow_localhost: bool,
    allowed_domains: list[str] | None = None,
    blocked_domains: list[str] | None = None,
) -> tuple[bool, str | None]:
    parsed = urlparse(raw_url)
    if parsed.scheme not in {"http", "https"}:
        return False, "Only http/https URLs are allowed."

    host = _normalize_host(parsed.hostname or "")
    if not host:
        return False, "Invalid URL host."

    if not allow_localhost and host in _LOCAL_BLOCKLIST:
        return False, "Access to localhost/loopback is blocked."

    allowed = [rule for rule in (allowed_domains or []) if str(rule or "").strip()]
    blocked = [rule for rule in (blocked_domains or []) if str(rule or "").strip()]
    if allowed and not any(host_matches_rule(host, rule) for rule in allowed):
        return False, f"Host '{host}' is not in allowedDomains."
    if blocked and any(host_matches_rule(host, rule) for rule in blocked):
        return False, f"Host '{host}' is blocked."

    literal_ip = _parse_ip_literal(host)
    if not allow_localhost and literal_ip is not None and _is_blocked_ip(literal_ip):
        return False, "Access to private, loopback, or link-local addresses is blocked."

    if not allow_localhost:
        for resolved_ip in _resolve_host_ips(host):
            if _is_blocked_ip(resolved_ip):
                return False, "Resolved host points to a private, loopback, or link-local address."

    return True, None
