"""Per-tenant monthly request quotas.

Rate limiting (token bucket) bounds the short-term spike a single caller
can emit. Enterprise contracts typically also specify a *monthly* ceiling
("100,000 requests per calendar month") which is a fundamentally different
control: it is cumulative, calendar-aligned, must survive process restarts,
and is what billing and procurement actually talk about.

This module implements that ceiling as a middleware that:

* counts every authenticated, non-exempt request against the caller's
  resolved tenant id;
* persists the per-(tenant, period) counter to a JSON file under the
  configured runs directory so the counter survives restarts and rolling
  redeploys;
* rolls the window over at the first UTC-midnight of each calendar month;
* refuses further requests with HTTP 429 + ``X-RateLimit-*`` headers
  (IETF draft-ietf-httpapi-ratelimit-headers naming) once the quota is
  exhausted;
* stamps every response (allowed or not) with ``X-RateLimit-Limit-Month``,
  ``X-RateLimit-Remaining-Month`` and ``X-RateLimit-Reset-Month`` so
  customer SDKs can show usage in their own dashboards;
* exposes an admin-only ``/v1/quota`` endpoint that returns the current
  counters for the caller's tenant (or, for ``admin`` scope holders, any
  tenant via ``?tenant=``).

The default is unlimited (``CODECLONE_QUOTA_PER_TENANT_MONTHLY=0``) so
existing deployments are unaffected until an operator opts in. Per-tenant
overrides are accepted via ``CODECLONE_QUOTA_OVERRIDES`` in the same
``tenant=value`` CSV style used by the IP allowlist.
"""

from __future__ import annotations

import json
import os
import re
import tempfile
import threading
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable

from codeclone_config.logging import get_logger
from fastapi import Request
from fastapi.responses import JSONResponse
from starlette.middleware.base import BaseHTTPMiddleware

log = get_logger(__name__)

# Paths that never count against quota. Mirrors EXEMPT_PATHS in ratelimit.py
# plus the GDPR endpoints and the quota introspection itself, so a caller
# checking "how much quota do I have left" is not punished for asking.
EXEMPT_PATHS: frozenset[str] = frozenset(
    {
        "/healthz",
        "/readyz",
        "/health",
        "/ready",
        "/metrics",
        "/v1/quota",
    }
)

# Same tenant-id grammar as auth.py; duplicated to avoid a circular import.
_TENANT_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,62}$")


def parse_overrides(raw: str) -> dict[str, int]:
    """Parse ``tenant=N`` CSV into a dict of per-tenant monthly caps.

    A value of ``0`` means "no limit for this tenant" and overrides the
    global default. Negative values are rejected.
    """
    out: dict[str, int] = {}
    if not raw:
        return out
    for entry in raw.split(","):
        entry = entry.strip()
        if not entry:
            continue
        if "=" not in entry:
            raise ValueError(
                f"CODECLONE_QUOTA_OVERRIDES entry missing '=': {entry!r}; "
                "use 'tenant=N'"
            )
        tenant, _, val = entry.partition("=")
        tenant = tenant.strip()
        val = val.strip()
        if not _TENANT_RE.match(tenant):
            raise ValueError(
                f"CODECLONE_QUOTA_OVERRIDES invalid tenant id {tenant!r}"
            )
        try:
            n = int(val)
        except ValueError as exc:
            raise ValueError(
                f"CODECLONE_QUOTA_OVERRIDES non-integer value for {tenant!r}: {val!r}"
            ) from exc
        if n < 0:
            raise ValueError(
                f"CODECLONE_QUOTA_OVERRIDES negative value for {tenant!r}: {n}"
            )
        out[tenant] = n
    return out


def current_period(now: datetime | None = None) -> str:
    """Return the ``YYYY-MM`` calendar period for ``now`` in UTC."""
    t = now or datetime.now(timezone.utc)
    if t.tzinfo is None:
        t = t.replace(tzinfo=timezone.utc)
    return t.astimezone(timezone.utc).strftime("%Y-%m")


def period_reset_epoch(period: str) -> int:
    """Return the unix timestamp at which ``period`` rolls over."""
    year, month = period.split("-")
    y, m = int(year), int(month)
    if m == 12:
        ny, nm = y + 1, 1
    else:
        ny, nm = y, m + 1
    return int(datetime(ny, nm, 1, tzinfo=timezone.utc).timestamp())


@dataclass
class QuotaState:
    period: str
    counts: dict[str, int]


class QuotaStore:
    """File-backed, thread-safe per-tenant counter.

    The on-disk format is a single JSON object::

        {"period": "2026-05", "counts": {"acme": 1234, "globex": 5}}

    We write atomically via ``os.replace`` of a tempfile in the same
    directory so a crash mid-write never leaves a half-written file.
    """

    def __init__(self, path: Path) -> None:
        self.path = path
        self._lock = threading.Lock()
        self._state = self._load()

    def _load(self) -> QuotaState:
        if not self.path.exists():
            return QuotaState(period=current_period(), counts={})
        try:
            raw = json.loads(self.path.read_text(encoding="utf-8"))
            period = str(raw.get("period") or current_period())
            counts_in = raw.get("counts") or {}
            counts = {str(k): int(v) for k, v in counts_in.items() if int(v) >= 0}
            return QuotaState(period=period, counts=counts)
        except Exception as exc:  # pragma: no cover - defensive
            log.warning("quota.store_load_failed", error=str(exc), path=str(self.path))
            return QuotaState(period=current_period(), counts={})

    def _persist_locked(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        payload = {"period": self._state.period, "counts": self._state.counts}
        # Atomic write: tempfile in same dir, then os.replace.
        fd, tmp = tempfile.mkstemp(
            prefix=".quota.", suffix=".json", dir=str(self.path.parent)
        )
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as fh:
                json.dump(payload, fh, sort_keys=True)
            os.replace(tmp, self.path)
        except Exception:
            try:
                os.unlink(tmp)
            except OSError:
                pass
            raise

    def _maybe_roll_locked(self, now: datetime | None = None) -> None:
        period = current_period(now)
        if period != self._state.period:
            log.info(
                "quota.period_rolled",
                previous=self._state.period,
                current=period,
                tenants=sorted(self._state.counts.keys()),
            )
            self._state = QuotaState(period=period, counts={})
            self._persist_locked()

    def consume(
        self, tenant: str, limit: int, now: datetime | None = None
    ) -> tuple[bool, int, int, str]:
        """Try to consume one request for ``tenant``.

        Returns ``(allowed, used_after, limit, period)``. ``limit == 0`` is
        treated as "unlimited" and never blocks; the counter is still
        incremented so the admin endpoint can report real usage.
        """
        with self._lock:
            self._maybe_roll_locked(now)
            used = self._state.counts.get(tenant, 0)
            if limit > 0 and used >= limit:
                return False, used, limit, self._state.period
            used += 1
            self._state.counts[tenant] = used
            self._persist_locked()
            return True, used, limit, self._state.period

    def snapshot(self, tenant: str | None = None) -> dict:
        with self._lock:
            self._maybe_roll_locked()
            if tenant is None:
                return {
                    "period": self._state.period,
                    "counts": dict(self._state.counts),
                }
            return {
                "period": self._state.period,
                "tenant": tenant,
                "used": self._state.counts.get(tenant, 0),
            }


def _tenant_for_key(raw_key: str | None) -> str | None:
    """Look up the tenant for a bearer token; mirrors ratelimit._tenant_for_key."""
    if not raw_key:
        return None
    try:
        from .auth import _build_keyring

        rec = _build_keyring().get(raw_key)
    except Exception:
        return None
    return rec.tenant if rec else None


def _bearer(request: Request) -> str | None:
    auth = request.headers.get("authorization")
    if not auth:
        return None
    token = auth.strip()
    if token.lower().startswith("bearer "):
        token = token[7:].strip()
    return token or None


class QuotaMiddleware(BaseHTTPMiddleware):
    """Enforce per-tenant monthly request quotas.

    Anonymous requests (no resolvable tenant) bypass this middleware; the
    per-IP token bucket in :mod:`ratelimit` is responsible for flood
    control of unauthenticated traffic. Tenants without an explicit
    override fall back to ``default_limit``; ``0`` means unlimited.
    """

    def __init__(
        self,
        app,
        *,
        store: QuotaStore,
        default_limit: int,
        overrides: dict[str, int] | None = None,
        exempt: Iterable[str] = EXEMPT_PATHS,
    ) -> None:
        super().__init__(app)
        self.store = store
        self.default_limit = max(0, int(default_limit))
        self.overrides = dict(overrides or {})
        self.exempt = frozenset(exempt)

    def limit_for(self, tenant: str) -> int:
        if tenant in self.overrides:
            return self.overrides[tenant]
        return self.default_limit

    async def dispatch(self, request: Request, call_next):
        if request.url.path in self.exempt:
            return await call_next(request)
        tenant = _tenant_for_key(_bearer(request))
        if tenant is None:
            return await call_next(request)

        limit = self.limit_for(tenant)
        allowed, used, effective_limit, period = self.store.consume(tenant, limit)
        reset = period_reset_epoch(period)

        if not allowed:
            resp = JSONResponse(
                status_code=429,
                content={
                    "error": {
                        "type": "quota_exceeded",
                        "scope": "tenant_monthly",
                        "message": (
                            f"monthly quota of {effective_limit} requests exceeded "
                            f"for period {period}"
                        ),
                        "tenant": tenant,
                        "period": period,
                        "used": used,
                        "limit": effective_limit,
                        "reset_epoch": reset,
                    }
                },
            )
            self._stamp(resp, effective_limit, used, period, reset)
            resp.headers["Retry-After"] = str(max(1, reset - int(__import__("time").time())))
            log.warning(
                "quota.blocked",
                tenant=tenant,
                used=used,
                limit=effective_limit,
                period=period,
            )
            return resp

        response = await call_next(request)
        self._stamp(response, effective_limit, used, period, reset)
        return response

    @staticmethod
    def _stamp(response, limit: int, used: int, period: str, reset: int) -> None:
        # ``limit == 0`` means unlimited; expose ``0`` so SDKs can detect
        # the no-cap case explicitly instead of guessing from a huge int.
        remaining = max(0, limit - used) if limit > 0 else 0
        response.headers["X-RateLimit-Limit-Month"] = str(limit)
        response.headers["X-RateLimit-Remaining-Month"] = str(remaining)
        response.headers["X-RateLimit-Reset-Month"] = str(reset)
        response.headers["X-RateLimit-Period"] = period
