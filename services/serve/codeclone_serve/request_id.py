"""Request-ID middleware.

Assigns or honors an ``X-Request-ID`` for every incoming HTTP request and
binds it into ``structlog`` contextvars so every log line emitted while the
request is in flight is automatically correlated. The id is also written to
the response headers so downstream callers and SIEM tools can stitch a single
trace end to end.

This middleware is intentionally cheap and standalone so it can run even when
the audit log is disabled. The audit middleware reuses the same id when both
are mounted.

Header policy:
    inbound  ``X-Request-ID``  honored if 1..128 chars of [A-Za-z0-9._:-]
    otherwise a 16 hex char id is minted (collision resistant per process)

The bound id is exposed in three places:
    * ``request.state.request_id`` for route handlers
    * ``X-Request-ID`` response header
    * ``structlog`` contextvars under the key ``request_id``
"""

from __future__ import annotations

import re
import secrets

import structlog
from starlette.datastructures import Headers
from starlette.types import ASGIApp, Message, Receive, Scope, Send

_REQUEST_ID_RE = re.compile(r"^[A-Za-z0-9._:\-]{1,128}$")
_HEADER_NAME = b"x-request-id"


def _new_id() -> str:
    # 16 hex chars = 64 bits of entropy; plenty for in-flight correlation.
    return secrets.token_hex(8)


def _sanitize(raw: str | None) -> str | None:
    if not raw:
        return None
    raw = raw.strip()
    if not raw:
        return None
    return raw if _REQUEST_ID_RE.match(raw) else None


class RequestIdMiddleware:
    """Pure ASGI middleware so it composes with streaming responses."""

    def __init__(self, app: ASGIApp, *, header_name: str = "x-request-id") -> None:
        self.app = app
        self.header_name = header_name.lower().encode("ascii")

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        headers = Headers(scope=scope)
        req_id = _sanitize(headers.get(self.header_name.decode("ascii"))) or _new_id()

        # Surface to route handlers via request.state.
        state = scope.setdefault("state", {})
        state["request_id"] = req_id

        # Also inject into the inbound headers so downstream middleware
        # (audit log, tracing, etc.) sees the same id without re-deriving it.
        raw_in = list(scope.get("headers") or [])
        raw_in = [(k, v) for (k, v) in raw_in if k.lower() != self.header_name]
        raw_in.append((self.header_name, req_id.encode("ascii")))
        scope["headers"] = raw_in

        # Bind into structlog so every log call inside this request carries it.
        token = structlog.contextvars.bind_contextvars(request_id=req_id)

        async def _send(message: Message) -> None:
            if message["type"] == "http.response.start":
                raw_headers = list(message.get("headers") or [])
                # Replace any pre-existing X-Request-ID to keep a single value.
                raw_headers = [
                    (k, v) for (k, v) in raw_headers if k.lower() != self.header_name
                ]
                raw_headers.append((self.header_name, req_id.encode("ascii")))
                message = {**message, "headers": raw_headers}
            await send(message)

        try:
            await self.app(scope, receive, _send)
        finally:
            # ``token`` from bind_contextvars is a dict of contextvar tokens.
            structlog.contextvars.reset_contextvars(**token)
