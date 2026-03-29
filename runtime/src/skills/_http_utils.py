"""Shared HTTP utilities for http_client and web_fetch tools."""

from __future__ import annotations

import ipaddress
import socket
from typing import Any
from urllib.parse import urlparse

_LOCAL_BLOCKLIST = {"localhost", "127.0.0.1", "::1", "0.0.0.0"}
_FAKE_IP_NETWORKS = (
    ipaddress.ip_network("198.18.0.0/15"),
)


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


def _blocked_ip_reason(address: ipaddress._BaseAddress) -> str | None:
    if address.is_loopback:
        return "loopback"
    if address.is_private:
        return "private"
    if address.is_link_local:
        return "link-local"
    if address.is_reserved:
        return "reserved/test-network"
    if address.is_unspecified:
        return "unspecified"
    if address.is_multicast:
        return "multicast"
    return None


def _is_fake_ip_address(address: ipaddress._BaseAddress) -> bool:
    if not isinstance(address, ipaddress.IPv4Address):
        return False
    return any(address in network for network in _FAKE_IP_NETWORKS)


def _is_blocked_ip(address: ipaddress._BaseAddress) -> bool:
    return _blocked_ip_reason(address) is not None


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


def inspect_remote_url(
    raw_url: str,
    *,
    allow_localhost: bool,
    allowed_domains: list[str] | None = None,
    blocked_domains: list[str] | None = None,
) -> tuple[str, dict[str, Any] | None]:
    parsed = urlparse(raw_url)
    if parsed.scheme not in {"http", "https"}:
        return "blocked", {"reason": "Only http/https URLs are allowed."}

    host = _normalize_host(parsed.hostname or "")
    if not host:
        return "blocked", {"reason": "Invalid URL host."}

    if not allow_localhost and host in _LOCAL_BLOCKLIST:
        return "blocked", {"reason": "Access to localhost/loopback is blocked.", "host": host}

    allowed = [rule for rule in (allowed_domains or []) if str(rule or "").strip()]
    blocked = [rule for rule in (blocked_domains or []) if str(rule or "").strip()]
    if allowed and not any(host_matches_rule(host, rule) for rule in allowed):
        return "blocked", {"reason": f"Host '{host}' is not in allowedDomains.", "host": host}
    if blocked and any(host_matches_rule(host, rule) for rule in blocked):
        return "blocked", {"reason": f"Host '{host}' is blocked.", "host": host}

    literal_ip = _parse_ip_literal(host)
    if not allow_localhost and literal_ip is not None:
        blocked_reason = _blocked_ip_reason(literal_ip)
        if blocked_reason is not None:
            if _is_fake_ip_address(literal_ip):
                return "approval_required", {
                    "host": host,
                    "resolved_ip": str(literal_ip),
                    "blocked_reason": blocked_reason,
                    "guard": "fake_ip_dns",
                }
            return "blocked", {
                "reason": f"Access to blocked address is denied: {literal_ip} ({blocked_reason}).",
                "host": host,
                "resolved_ip": str(literal_ip),
                "blocked_reason": blocked_reason,
            }

    if not allow_localhost:
        for resolved_ip in _resolve_host_ips(host):
            blocked_reason = _blocked_ip_reason(resolved_ip)
            if blocked_reason is None:
                continue
            if _is_fake_ip_address(resolved_ip):
                return "approval_required", {
                    "host": host,
                    "resolved_ip": str(resolved_ip),
                    "blocked_reason": blocked_reason,
                    "guard": "fake_ip_dns",
                }
            return "blocked", {
                "reason": f"Resolved host points to a blocked address: {resolved_ip} ({blocked_reason}).",
                "host": host,
                "resolved_ip": str(resolved_ip),
                "blocked_reason": blocked_reason,
            }

    return "ok", {"host": host}


def validate_remote_url(
    raw_url: str,
    *,
    allow_localhost: bool,
    allowed_domains: list[str] | None = None,
    blocked_domains: list[str] | None = None,
    allow_fake_ip_override: bool = False,
) -> tuple[bool, str | None]:
    status, detail = inspect_remote_url(
        raw_url,
        allow_localhost=allow_localhost,
        allowed_domains=allowed_domains,
        blocked_domains=blocked_domains,
    )
    if status == "ok":
        return True, None
    if status == "approval_required" and allow_fake_ip_override:
        return True, None
    return False, str((detail or {}).get("reason") or (
        "Resolved host points to a fake-ip DNS address and requires approval override."
        if status == "approval_required"
        else "Invalid URL"
    ))
