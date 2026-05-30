"""Persistent audit log for the serve API.

Captures who (API key fingerprint), what (method + route + model), when (UTC
ISO 8601), where from (remote IP, optional forwarded), and outcome (status
code, latency, request id) for every request handled by the API.

The audit log is append-only JSONL written to ``CODECLONE_AUDIT_LOG_PATH``
(default ``./runs/audit.log``). One line per request. Safe to ``tail -f`` and
safe to ship to a SIEM via Filebeat, Vector, or Promtail.

Design notes:
- We hash the API key with SHA-256 and only persist the first 12 hex chars so
  the log itself is not a credential. The hash is stable across restarts so
  per-key activity is correlatable.
- Auth failures are logged with ``actor="anonymous"`` so brute-force attempts
  show up in the audit trail.
- Health and metrics endpoints are excluded to keep the signal high.
- Writes happen on a background thread via ``queue.SimpleQueue`` so request
  latency is not bound by disk fsync.
- Implemented as a raw ASGI middleware so it composes cleanly with streaming
  responses (Server-Sent Events) and never buffers the response body.
"""

from __future__ import annotations

import contextlib
import gzip
import hashlib
import json
import os
import queue
import shutil
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from starlette.datastructures import Headers
from starlette.types import ASGIApp, Message, Receive, Scope, Send

DEFAULT_EXCLUDE = frozenset({"/healthz", "/readyz", "/metrics", "/favicon.ico"})


def _hash_key(raw: str | None) -> str:
    if not raw:
        return "anonymous"
    digest = hashlib.sha256(raw.encode("utf-8")).hexdigest()
    return f"key:{digest[:12]}"


def _extract_key(headers: Headers) -> str | None:
    auth = headers.get("authorization")
    if not auth:
        return None
    token = auth.strip()
    if token.lower().startswith("bearer "):
        token = token[7:].strip()
    return token or None


def _client_ip(scope: Scope, headers: Headers, trust_forwarded: bool) -> str:
    if trust_forwarded:
        xff = headers.get("x-forwarded-for")
        if xff:
            return xff.split(",")[0].strip()
    client = scope.get("client")
    if not client:
        return "unknown"
    return client[0]


class AuditSink:
    """Background-thread JSONL writer. Process-local, append-only.

    Supports size-based rotation with a gzip-compressed retention window so
    the audit trail survives long-running pods without filling the volume.
    Rotation is opt-out: set ``max_bytes=0`` to keep the legacy single-file
    behavior. ``backup_count`` controls how many rotated ``.gz`` files we
    keep; older files are pruned in age order on each rotation.
    """

    def __init__(
        self,
        path: Path,
        *,
        max_bytes: int = 0,
        backup_count: int = 0,
    ) -> None:
        if max_bytes < 0:
            raise ValueError("max_bytes must be >= 0")
        if backup_count < 0:
            raise ValueError("backup_count must be >= 0")
        self.path = path
        self.max_bytes = max_bytes
        self.backup_count = backup_count
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._queue: queue.SimpleQueue[dict[str, Any] | None] = queue.SimpleQueue()
        self._thread = threading.Thread(
            target=self._run, name="codeclone-audit", daemon=True
        )
        self._thread.start()

    def write(self, record: dict[str, Any]) -> None:
        self._queue.put(record)

    def flush(self, timeout: float = 2.0) -> None:
        """Block until the queue is drained or timeout elapses (tests use this)."""
        deadline = time.monotonic() + timeout
        while not self._queue.empty() and time.monotonic() < deadline:
            time.sleep(0.01)

    def close(self) -> None:
        self._queue.put(None)
        self._thread.join(timeout=2.0)

    def _run(self) -> None:
        # Line-buffered append. POSIX guarantees atomicity for sub-PIPE_BUF
        # writes; audit lines are well under 4 KiB.
        fh = self.path.open("a", encoding="utf-8", buffering=1)
        try:
            while True:
                item = self._queue.get()
                if item is None:
                    return
                try:
                    line = json.dumps(item, separators=(",", ":")) + "\n"
                    fh.write(line)
                    if self.max_bytes and self._should_rotate(fh, len(line)):
                        fh.close()
                        self._rotate()
                        fh = self.path.open("a", encoding="utf-8", buffering=1)
                except Exception:
                    continue
        finally:
            with contextlib.suppress(Exception):
                fh.close()

    def _should_rotate(self, fh: Any, last_write: int) -> bool:
        try:
            return fh.tell() >= self.max_bytes
        except (OSError, ValueError):
            # ``tell`` can fail on some file-likes; fall back to stat.
            try:
                return self.path.stat().st_size >= self.max_bytes
            except OSError:
                return False

    def _rotate(self) -> None:
        """Move ``audit.log`` to ``audit.log.<ts>.gz`` and prune old backups.

        Uses a UTC timestamp suffix so rotated files sort chronologically and
        operators can pattern-match by date when shipping to cold storage.
        """
        if not self.path.exists():
            return
        if self.backup_count == 0:
            # Rotation requested without retention: just truncate.
            with contextlib.suppress(OSError):
                self.path.unlink()
            return
        ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        rotated = self.path.with_name(f"{self.path.name}.{ts}.gz")
        # Avoid collisions when rotations happen within the same second.
        counter = 0
        while rotated.exists():
            counter += 1
            rotated = self.path.with_name(f"{self.path.name}.{ts}.{counter}.gz")
        try:
            with self.path.open("rb") as src, gzip.open(
                rotated, "wb", compresslevel=6
            ) as dst:
                shutil.copyfileobj(src, dst)
            self.path.unlink()
        except OSError:
            return
        self._prune_backups()

    def _prune_backups(self) -> None:
        prefix = f"{self.path.name}."
        backups = sorted(
            (p for p in self.path.parent.glob(f"{prefix}*.gz") if p.is_file()),
            key=lambda p: p.stat().st_mtime,
        )
        excess = len(backups) - self.backup_count
        for old in backups[:excess]:
            try:
                old.unlink()
            except OSError:
                continue


class AuditMiddleware:
    """Raw ASGI middleware. Persists one JSONL row per HTTP request.

    Implemented at the ASGI layer rather than as a ``BaseHTTPMiddleware`` so
    streaming responses (SSE) pass through unbuffered.
    """

    def __init__(
        self,
        app: ASGIApp,
        sink: AuditSink,
        *,
        exclude_paths: frozenset[str] = DEFAULT_EXCLUDE,
        trust_forwarded: bool = False,
    ) -> None:
        self.app = app
        self.sink = sink
        self.exclude_paths = exclude_paths
        self.trust_forwarded = trust_forwarded

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        path = scope.get("path", "")
        if path in self.exclude_paths:
            await self.app(scope, receive, send)
            return

        headers = Headers(scope=scope)

        # Request-id correlation. Honor inbound header, otherwise mint one.
        req_id = headers.get("x-request-id") or hashlib.sha1(
            f"{time.time_ns()}-{id(scope)}".encode()
        ).hexdigest()[:16]

        actor = _hash_key(_extract_key(headers))
        ip = _client_ip(scope, headers, self.trust_forwarded)
        user_agent = headers.get("user-agent", "")
        method = scope.get("method", "GET")

        # Best-effort capture of model name from a JSON POST body, by buffering
        # the request stream once and replaying it. We bound this to small
        # bodies so we never pin large prompts in memory.
        model_name: str | None = None
        content_type = headers.get("content-type", "")
        try:
            content_length = int(headers.get("content-length", "0"))
        except ValueError:
            content_length = 0

        wrapped_receive = receive
        if (
            method == "POST"
            and "json" in content_type
            and 0 < content_length <= 256_000
        ):
            buffered_body = bytearray()
            more = True
            while more:
                message = await receive()
                if message["type"] == "http.request":
                    buffered_body.extend(message.get("body", b"") or b"")
                    more = message.get("more_body", False)
                else:
                    # Disconnect or unknown; forward it as-is.
                    more = False

            body_bytes = bytes(buffered_body)
            try:
                parsed = json.loads(body_bytes) if body_bytes else None
                if isinstance(parsed, dict):
                    m = parsed.get("model")
                    if isinstance(m, str):
                        model_name = m
            except (ValueError, json.JSONDecodeError):
                pass

            replay_done = False

            async def _replay() -> Message:
                nonlocal replay_done
                if not replay_done:
                    replay_done = True
                    return {
                        "type": "http.request",
                        "body": body_bytes,
                        "more_body": False,
                    }
                return await receive()

            wrapped_receive = _replay

        t0 = time.perf_counter()
        status_holder: dict[str, int] = {"status": 500}
        trace_holder: dict[str, str] = {}

        async def _send(message: Message) -> None:
            if message["type"] == "http.response.start":
                status_holder["status"] = int(message.get("status", 500))
                # Capture the OTel trace context while the request span is
                # still active. By the time we emit the audit record below the
                # span may already be ended and the context detached.
                if not trace_holder:
                    try:
                        from .tracing import current_trace_context

                        trace_holder.update(current_trace_context())
                    except Exception:
                        pass
            await send(message)

        try:
            await self.app(scope, wrapped_receive, _send)
        except Exception:
            if not trace_holder:
                try:
                    from .tracing import current_trace_context

                    trace_holder.update(current_trace_context())
                except Exception:
                    pass
            self._emit(
                req_id=req_id,
                actor=actor,
                ip=ip,
                ua=user_agent,
                method=method,
                path=path,
                status=500,
                latency_ms=(time.perf_counter() - t0) * 1000.0,
                model=model_name,
                error="unhandled_exception",
                trace=trace_holder,
            )
            raise

        self._emit(
            req_id=req_id,
            actor=actor,
            ip=ip,
            ua=user_agent,
            method=method,
            path=path,
            status=status_holder["status"],
            latency_ms=(time.perf_counter() - t0) * 1000.0,
            model=model_name,
            error=None,
            trace=trace_holder,
        )

    def _emit(
        self,
        *,
        req_id: str,
        actor: str,
        ip: str,
        ua: str,
        method: str,
        path: str,
        status: int,
        latency_ms: float,
        model: str | None,
        error: str | None,
        trace: dict[str, str] | None = None,
    ) -> None:
        record: dict[str, Any] = {
            "ts": datetime.now(timezone.utc).isoformat(),
            "request_id": req_id,
            "actor": actor,
            "remote_ip": ip,
            "user_agent": ua[:200],
            "method": method,
            "path": path,
            "status": status,
            "latency_ms": round(latency_ms, 2),
        }
        if trace:
            tid = trace.get("trace_id")
            sid = trace.get("span_id")
            if tid:
                record["trace_id"] = tid
            if sid:
                record["span_id"] = sid
        if model is not None:
            record["model"] = model
        if error is not None:
            record["error"] = error
        self.sink.write(record)


def build_sink_from_env(default_path: Path) -> AuditSink:
    """Resolve the audit log path and rotation policy from env.

    Reads ``CODECLONE_AUDIT_LOG_PATH`` for the destination plus the optional
    ``CODECLONE_AUDIT_LOG_MAX_BYTES`` and ``CODECLONE_AUDIT_LOG_BACKUP_COUNT``
    knobs that control gzip rotation. Defaults keep ~50 MiB hot and 14 gzip
    backups, matching the Helm chart defaults.
    """
    raw = os.environ.get("CODECLONE_AUDIT_LOG_PATH")
    path = Path(raw) if raw else default_path
    max_bytes = _coerce_int(os.environ.get("CODECLONE_AUDIT_LOG_MAX_BYTES"), 50 * 1024 * 1024)
    backup_count = _coerce_int(os.environ.get("CODECLONE_AUDIT_LOG_BACKUP_COUNT"), 14)
    return AuditSink(path, max_bytes=max_bytes, backup_count=backup_count)


def _coerce_int(raw: str | None, default: int) -> int:
    if raw is None or raw == "":
        return default
    try:
        value = int(raw)
    except (TypeError, ValueError):
        return default
    return value if value >= 0 else default
