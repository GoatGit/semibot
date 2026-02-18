"""
请求追踪中间件

接收 X-Request-ID 并注入到日志上下文
"""

import uuid

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import Response

from src.utils.logging import get_logger

logger = get_logger(__name__)


class TraceMiddleware(BaseHTTPMiddleware):
    """从 X-Request-ID header 读取或生成 trace_id，注入到 request.state 和响应 header。"""

    async def dispatch(self, request: Request, call_next) -> Response:
        trace_id = request.headers.get("x-request-id", str(uuid.uuid4()))
        request.state.trace_id = trace_id

        logger.info(
            "Request started",
            extra={"trace_id": trace_id, "method": request.method, "path": str(request.url.path)},
        )

        response: Response = await call_next(request)
        response.headers["x-request-id"] = trace_id

        return response
