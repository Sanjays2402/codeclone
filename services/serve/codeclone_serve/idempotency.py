"""Idempotency keys for POST inference endpoints.

Enterprise procurement requirement: any non-idempotent POST that costs money
or tokens must be safely retryable. Pattern follows Stripe / RFC draft
``draft-ietf-httpapi-idempotency-key-header``:

* Client sends ``Idempotency-Key: <opaque>`` on POST ``/v1/chat/completions``
  or ``/v1/completions``.
* First request for ``(tenant, key)`` is processed; the **full response body
  + status + relevant headers** are persisted to a JSONL store along with a
  SHA-256 of the request body.
* A subsequent request with the **same key + same body hash** within the TTL
  replays the stored response verbatim and sets ``Idempotency-Replayed: true``.
* Same key + **different body** returns ``409 Conflict`` with a structured
  error so the caller can fix their retry logic instead of silently getting
  stale data.

The store is keyed by ``(tenant, key)`` so two tenants can independently use
the same opaque key without bleeding (enforced by ``test_isolation``).

Streaming responses are intentionally **not** cached: SSE bodies aren't safe
to replay byte-for-byte, and Stripe's spec exempts streams too. A request
that sets ``stream=true`` still validates the key shape but does not store
or replay.

Storage is a small JSON-on-disk dict guarded by a thread lock. That keeps
the surface area tiny (no Redis dep) while still surviving process restarts,
which is what auditors care about. Expired entries are evicted lazily on
read.
"""

from __future__ import annotations

import hashlib
import json
import re
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

# Spec-aligned: opaque token, 1..255 visible ASCII chars. Reject control
# bytes, whitespace, and anything that would not survive log scraping.
_KEY_RE = re.compile(r"^[!-~]{1,255}$")

# 24h default. Long enough for retries across deploy + on-call paging,
# short enough that disk doesn't unboundedly grow.
DEFAULT_TTL_SECONDS = 24 * 60 * 60


class IdempotencyKeyError(ValueError):
    """Raised when the client sends a malformed Idempotency-Key header."""


def validate_key(raw: str) -> str:
    if not isinstance(raw, str) or not _KEY_RE.match(raw):
        raise IdempotencyKeyError(
            "Idempotency-Key must be 1..255 visible ASCII characters"
        )
    return raw


def fingerprint_body(body: Any) -> str:
    """Stable SHA-256 of a JSON-serialisable body.

    Sort keys so semantically-equal payloads (e.g. different dict ordering
    from a retry library) hash to the same value.
    """
    blob = json.dumps(body, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()


@dataclass(frozen=True)
class StoredResponse:
    status: int
    body: Any
    # Subset of response headers that callers actually care about. We
    # deliberately do not replay every header (no Date, no Server, no rate
    # limit counters: those must reflect the replay request, not the
    # original).
    headers: dict[str, str]
    body_fingerprint: str
    created_at: float


@dataclass(frozen=True)
class ReplayHit:
    """Result of a cache lookup."""

    response: StoredResponse


@dataclass(frozen=True)
class ReplayConflict:
    """Same key, different body: client bug."""

    stored_fingerprint: str
    new_fingerprint: str


class IdempotencyStore:
    """Tenant-scoped persistent idempotency cache.

    The on-disk layout is a single JSON object::

        {
            "<tenant>:<key>": {
                "status": 200,
                "body": {...},
                "headers": {"content-type": "application/json"},
                "body_fingerprint": "abc...",
                "created_at": 1700000000.0
            },
            ...
        }

    We accept the O(n) rewrite cost on every put because the cache is small
    (one entry per retry) and the alternative (sqlite/Redis) blows up the
    dependency surface for a feature that ships in a 25 minute window.
    """

    def __init__(self, path: Path, ttl_seconds: int = DEFAULT_TTL_SECONDS) -> None:
        self._path = Path(path)
        self._ttl = int(ttl_seconds)
        self._lock = threading.Lock()
        self._path.parent.mkdir(parents=True, exist_ok=True)

    # ---- low level ----
    def _load(self) -> dict[str, dict[str, Any]]:
        if not self._path.exists():
            return {}
        try:
            raw = self._path.read_text(encoding="utf-8")
        except OSError:
            return {}
        if not raw.strip():
            return {}
        try:
            data = json.loads(raw)
        except json.JSONDecodeError:
            # Corrupt file is recoverable: drop it. Audit log will still
            # have the original write, so no silent data loss.
            return {}
        return data if isinstance(data, dict) else {}

    def _save(self, data: dict[str, dict[str, Any]]) -> None:
        tmp = self._path.with_suffix(self._path.suffix + ".tmp")
        tmp.write_text(json.dumps(data, separators=(",", ":")), encoding="utf-8")
        tmp.replace(self._path)

    def _composite_key(self, tenant: str, key: str) -> str:
        # ``:`` is the delimiter; tenants are validated upstream
        # (lowercase DNS-label-ish) so they cannot contain colons.
        return f"{tenant}:{key}"

    # ---- public API ----
    def lookup(
        self, tenant: str, key: str, body_fingerprint: str
    ) -> ReplayHit | ReplayConflict | None:
        with self._lock:
            data = self._load()
            ck = self._composite_key(tenant, key)
            entry = data.get(ck)
            if entry is None:
                return None
            # TTL eviction. We rewrite to disk so the file does not grow
            # unboundedly across long-lived processes.
            if (time.time() - float(entry.get("created_at", 0))) > self._ttl:
                data.pop(ck, None)
                self._save(data)
                return None
            stored_fp = str(entry.get("body_fingerprint", ""))
            if stored_fp != body_fingerprint:
                return ReplayConflict(
                    stored_fingerprint=stored_fp, new_fingerprint=body_fingerprint
                )
            return ReplayHit(
                response=StoredResponse(
                    status=int(entry["status"]),
                    body=entry["body"],
                    headers=dict(entry.get("headers", {})),
                    body_fingerprint=stored_fp,
                    created_at=float(entry["created_at"]),
                )
            )

    def store(
        self,
        tenant: str,
        key: str,
        body_fingerprint: str,
        *,
        status: int,
        body: Any,
        headers: dict[str, str],
    ) -> None:
        with self._lock:
            data = self._load()
            ck = self._composite_key(tenant, key)
            data[ck] = {
                "status": int(status),
                "body": body,
                "headers": {k.lower(): v for k, v in headers.items()},
                "body_fingerprint": body_fingerprint,
                "created_at": time.time(),
            }
            self._save(data)
