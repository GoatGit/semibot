"""
跨层统一错误协议 — Python 端实现

与 packages/shared-types/src/error.ts 中的 UnifiedError 接口对齐。
"""

from __future__ import annotations


class UnifiedError(Exception):
    """跨层统一错误异常。

    字段与 TypeScript 侧 UnifiedError 接口一一对应：
      code, message, http_status, details, trace_id
    """

    def __init__(
        self,
        code: str,
        message: str,
        http_status: int = 500,
        details: dict | list | None = None,
        trace_id: str | None = None,
    ):
        super().__init__(message)
        self.code = code
        self.message = message
        self.http_status = http_status
        self.details = details
        self.trace_id = trace_id

    def to_dict(self) -> dict:
        """序列化为与 TypeScript UnifiedError 一致的 JSON 结构。"""
        d: dict = {
            "code": self.code,
            "message": self.message,
            "httpStatus": self.http_status,
        }
        if self.details is not None:
            d["details"] = self.details
        if self.trace_id is not None:
            d["traceId"] = self.trace_id
        return d
