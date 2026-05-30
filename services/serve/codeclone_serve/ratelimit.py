"""Token bucket rate limiting middleware for the CodeClone serve API.

Two independent buckets are checked per request:

  * per client IP (cheap brute force / runaway client guard)
  * per API key (per credential fairness, even behind a single NAT)

Buckets are kept in-process. For a single replica this is exact. For a
horizontally scaled deployment, put a real shared limiter (e.g. an Envoy
or NGINX rate-limit filter, or Redis token bucket) in front of this and
treat this layer as a defense-in-depth backstop.

The limiter is intentionally dependency-free (stdlib only) so it works
inside the existing FastAPI app without pulling new wheels.
"""

from __future__ import annotations

import threading
import time
from collections.abc import Callable, Iterable
from dataclasses import dataclass

from fastapi import Request
from fastapi.responses import JSONResponse
from starlette.middleware.base import BaseHTTPMiddleware

# Paths that must never be rate limited so health probes and Prometheus
# scrapes are not starved by a misbehaving client.
EXEMPT_PATHS: frozenset[str] = frozenset({"/healthz", "/readyz", "/metrics"})


@dataclass
class _Bucket:
    tokens: float
    last_refill: float


class TokenBucketLimiter:
    """In-memory token bucket keyed by an arbitrary identity string.

    `rate_per_minute` is the steady-state allowance. `burst` is the
    bucket capacity, i.e. the maximum short term spike a single identity
    may emit before being throttled.
    """

    def __init__(self, rate_per_minute: int, burst: int) -> None:
        if rate_per_minute <= 0:
            raise ValueError("rate_per_minute must be > 0")
        if burst <= 0:
            raise ValueError("burst must be > 0")
        self.rate_per_second = rate_per_minute / 60.0
        self.capacity = float(burst)
        self._buckets: dict[str, _Bucket] = {}
        self._lock = threading.Lock()

    def check(self, identity: str, now: float | None = None) -> tuple[bool, float]:
        """Try to consume one token. Returns (allowed, retry_after_seconds)."""
        t = time.monotonic() if now is None else now
        with self._lock:
            b = self._buckets.get(identity)
            if b is None:
                b = _Bucket(tokens=self.capacity, last_refill=t)
                self._buckets[identity] = b
            elapsed = max(0.0, t - b.last_refill)
            b.tokens = min(self.capacity, b.tokens + elapsed * self.rate_per_second)
            b.last_refill = t
            if b.tokens >= 1.0:
                b.tokens -= 1.0
                return True, 0.0
            # Not enough tokens, compute seconds until at least one is available.
            missing = 1.0 - b.tokens
            retry_after = missing / self.rate_per_second
            return False, retry_after

    def reset(self) -> None:
        with self._lock:
            self._buckets.clear()


def _client_ip(request: Request, trust_forwarded: bool) -> str:
    if trust_forwarded:
        fwd = request.headers.get("x-forwarded-for")
        if fwd:
            # Left-most entry is the original client per the standard.
            return fwd.split(",")[0].strip() or "unknown"
        real = request.headers.get("x-real-ip")
        if real:
            return real.strip()
    client = request.client
    return client.host if client else "unknown"


def _api_key(request: Request) -> str | None:
    auth = request.headers.get("authorization")
    if not auth:
        return None
    token = auth.strip()
    if token.lower().startswith("bearer "):
        token = token[7:].strip()
    return token or None


class RateLimitMiddleware(BaseHTTPMiddleware):
    """Per-IP and per-API-key token bucket middleware.

    Exempt paths (health probes, metrics) skip the limiter entirely.
    A blocked request returns HTTP 429 with `Retry-After` and a small
    JSON body describing which bucket tripped.
    """

    def __init__(
        self,
        app,
        *,
        per_ip: TokenBucketLimiter,
        per_key: TokenBucketLimiter,
        trust_forwarded: bool = False,
        exempt: Iterable[str] = EXEMPT_PATHS,
        clock: Callable[[], float] | None = None,
    ) -> None:
        super().__init__(app)
        self.per_ip = per_ip
        self.per_key = per_key
        self.trust_forwarded = trust_forwarded
        self.exempt = frozenset(exempt)
        self._clock = clock

    async def dispatch(self, request: Request, call_next):
        if request.url.path in self.exempt:
            return await call_next(request)

        now = self._clock() if self._clock else None

        ip = _client_ip(request, self.trust_forwarded)
        ok_ip, retry_ip = self.per_ip.check(f"ip:{ip}", now=now)
        if not ok_ip:
            return _too_many("ip", retry_ip)

        key = _api_key(request)
        if key is not None:
            ok_key, retry_key = self.per_key.check(f"key:{key}", now=now)
            if not ok_key:
                return _too_many("api_key", retry_key)

        return await call_next(request)


def _too_many(scope: str, retry_after: float) -> JSONResponse:
    # Always advertise at least one second so naive clients back off.
    seconds = max(1, int(retry_after + 0.999))
    return JSONResponse(
        status_code=429,
        content={
            "error": {
                "type": "rate_limit_exceeded",
                "scope": scope,
                "message": f"rate limit exceeded for {scope}",
                "retry_after_seconds": seconds,
            }
        },
        headers={"Retry-After": str(seconds)},
    )
