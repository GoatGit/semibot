"""Compatibility wrapper: use gateway notifier implementation."""

from src.gateway.notifiers.feishu_notifier import FeishuNotifier, SendFn, default_send_json

__all__ = ["SendFn", "FeishuNotifier", "default_send_json"]
