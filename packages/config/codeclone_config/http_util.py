"""HTTP utilities used across services."""

from __future__ import annotations

import time
from typing import Any, Callable, TypeVar

import httpx
from tenacity import (
    retry,
    retry_if_exception_type,
    stop_after_attempt,
    wait_exponential,
)


T = TypeVar("T")


class TransientError(RuntimeError):
    pass


def is_retryable(exc: BaseException) -> bool:
    if isinstance(exc, httpx.HTTPStatusError):
        return exc.response.status_code in (429, 500, 502, 503, 504)
    return isinstance(exc, (httpx.TimeoutException, httpx.ConnectError, TransientError))


def retry_call(fn: Callable[[], T], attempts: int = 5) -> T:
    """Run `fn` with exponential backoff on retryable network errors."""

    @retry(
        stop=stop_after_attempt(attempts),
        wait=wait_exponential(multiplier=0.5, min=0.5, max=8.0),
        retry=retry_if_exception_type(
            (httpx.TimeoutException, httpx.ConnectError, TransientError)
        ),
        reraise=True,
    )
    def _wrapped() -> T:
        return fn()

    return _wrapped()


def parse_rate_limit_reset(headers: dict[str, str]) -> float:
    """Return seconds to wait until the GitHub rate limit resets, or 0."""
    reset = headers.get("X-RateLimit-Reset") or headers.get("x-ratelimit-reset")
    if not reset:
        return 0.0
    try:
        return max(0.0, float(reset) - time.time())
    except ValueError:
        return 0.0
