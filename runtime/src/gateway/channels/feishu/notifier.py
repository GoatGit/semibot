"""Feishu channel notifier.

Current implementation reuses the existing notifier module and serves as the
channel-local import surface for the plugin architecture.
"""

from src.gateway.notifiers.feishu_notifier import (
    FeishuNotifier,
    SdkSendFn,
    SendFn,
    default_send_json,
)

__all__ = [
    "FeishuNotifier",
    "SdkSendFn",
    "SendFn",
    "default_send_json",
]
