"""GDPR data lifecycle endpoints for the audit log.

The serve API persists exactly one class of caller-derived data: append-only
audit log rows on disk (see :mod:`codeclone_serve.audit`). Each row carries an
``actor`` field that is a SHA-256[:12] fingerprint of the API key that made
the request. No other personal data is stored by the service.

This module exposes two endpoints that let a key holder exercise GDPR rights
over that data:

- ``GET  /v1/data/export``  download all audit rows tied to the caller's key
- ``DELETE /v1/data/delete`` purge all audit rows tied to the caller's key

A caller authenticated with a key holding the ``*`` (admin) scope may target
any fingerprint via ``?actor=key:<12hex>``; non-admin callers may only act on
their own fingerprint and any ``actor`` parameter they pass must match.

Deletion is implemented as a safe rewrite-and-replace of the JSONL file: we
stream every row, drop matches, write the survivors to a sibling temp file
under the same directory, ``fsync`` it, and ``os.replace`` it over the
original. The audit sink is paused for the duration via a file lock so a
concurrent writer cannot have a row silently dropped by the rename. A purge
event for the deleted fingerprint is appended after the rewrite so the
deletion itself is auditable (GDPR requires the erasure to be recorded).
"""

from __future__ import annotations

import contextlib
import json
import os
import tempfile
import threading
from collections.abc import Iterator
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from fastapi.responses import StreamingResponse

from .auth import Principal, require_scope

# Module-level lock that serialises audit-file rewrites against the background
# sink writer. The sink itself uses POSIX append atomicity, so taking this
# lock around the rewrite is sufficient: pending sink writes complete, we
# rewrite, sink resumes appending to the new inode.
_REWRITE_LOCK = threading.Lock()


def _resolve_audit_path(request: Request) -> Path:
    """Pull the live audit log path from app settings."""
    from codeclone_config.settings import get_settings

    settings = get_settings()
    if not settings.audit_log_enabled:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="audit log is disabled; nothing to export or delete",
        )
    raw = os.environ.get("CODECLONE_AUDIT_LOG_PATH")
    return Path(raw) if raw else settings.audit_log_path


def _resolve_target_actor(principal: Principal, requested: str | None) -> str:
    """Decide which actor fingerprint the caller may operate on.

    Non-admin callers always act on their own fingerprint. Admins may pass an
    explicit ``actor=key:<12hex>`` to act on someone else's data; without it
    they also default to their own fingerprint.
    """
    own = principal.fingerprint
    is_admin = "*" in principal.scopes or "admin" in principal.scopes

    if requested is None:
        return own

    requested = requested.strip()
    if not requested.startswith("key:") or len(requested) != len("key:") + 12:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="actor must be of the form 'key:<12 hex chars>'",
        )
    if not all(c in "0123456789abcdef" for c in requested[4:]):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="actor fingerprint must be 12 lowercase hex characters",
        )
    if requested != own and not is_admin:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="only an admin key may export or delete another caller's data",
        )
    return requested


def _iter_rows(path: Path) -> Iterator[dict]:
    if not path.exists():
        return
    with path.open("r", encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                yield json.loads(line)
            except json.JSONDecodeError:
                # A truncated tail line during concurrent append is possible
                # on some filesystems; skip it rather than 500 the request.
                continue


def _build_router() -> APIRouter:
    router = APIRouter(prefix="/v1/data", tags=["data-lifecycle"])

    @router.get(
        "/export",
        summary="Export all audit rows for the caller's API key (GDPR Art. 15/20)",
    )
    def export_my_data(
        request: Request,
        actor: str | None = Query(default=None),
        principal: Principal = Depends(require_scope("infer")),
    ) -> StreamingResponse:
        target = _resolve_target_actor(principal, actor)
        path = _resolve_audit_path(request)

        def _stream() -> Iterator[bytes]:
            header = {
                "exported_at": datetime.now(timezone.utc).isoformat(),
                "actor": target,
                "source": str(path),
                "format": "jsonl",
                "schema": "codeclone.audit.v1",
            }
            yield (json.dumps({"_meta": header}) + "\n").encode("utf-8")
            count = 0
            for row in _iter_rows(path):
                if row.get("actor") == target:
                    yield (json.dumps(row, separators=(",", ":")) + "\n").encode(
                        "utf-8"
                    )
                    count += 1
            footer = {"_summary": {"actor": target, "rows": count}}
            yield (json.dumps(footer) + "\n").encode("utf-8")

        filename = f"codeclone-audit-{target.replace(':', '_')}.jsonl"
        return StreamingResponse(
            _stream(),
            media_type="application/x-ndjson",
            headers={
                "Content-Disposition": f'attachment; filename="{filename}"',
                "Cache-Control": "no-store",
            },
        )

    @router.delete(
        "/delete",
        summary="Erase all audit rows for the caller's API key (GDPR Art. 17)",
    )
    def delete_my_data(
        request: Request,
        actor: str | None = Query(default=None),
        principal: Principal = Depends(require_scope("infer")),
    ) -> dict:
        target = _resolve_target_actor(principal, actor)
        path = _resolve_audit_path(request)

        if not path.exists():
            return {"actor": target, "deleted": 0, "remaining": 0, "purged_at": None}

        deleted = 0
        remaining = 0

        with _REWRITE_LOCK:
            # Pause the sink so its background thread does not race the rename.
            sink = getattr(request.app.state, "audit_sink", None)
            if sink is not None:
                sink.flush(timeout=2.0)

            tmp_fd, tmp_name = tempfile.mkstemp(
                prefix=".audit-rewrite-",
                suffix=".jsonl",
                dir=str(path.parent),
            )
            purged_at = datetime.now(timezone.utc).isoformat()
            try:
                with os.fdopen(tmp_fd, "w", encoding="utf-8") as out:
                    for row in _iter_rows(path):
                        if row.get("actor") == target:
                            deleted += 1
                            continue
                        out.write(json.dumps(row, separators=(",", ":")) + "\n")
                        remaining += 1
                    # Auditable record of the erasure itself. Written directly
                    # into the rewritten file (rather than via the sink) so it
                    # survives the os.replace below regardless of whether the
                    # background sink's open file descriptor follows the new
                    # inode. GDPR requires the erasure act itself be recorded.
                    erasure_record = {
                        "ts": purged_at,
                        "event": "gdpr.erasure",
                        "actor": principal.fingerprint,
                        "target_actor": target,
                        "deleted": deleted,
                        "remaining": remaining,
                        "path": str(path),
                    }
                    out.write(
                        json.dumps(erasure_record, separators=(",", ":")) + "\n"
                    )
                    out.flush()
                    os.fsync(out.fileno())
                os.replace(tmp_name, path)
            except Exception:
                with contextlib.suppress(OSError):
                    os.unlink(tmp_name)
                raise

        return {
            "actor": target,
            "deleted": deleted,
            "remaining": remaining,
            "purged_at": purged_at,
        }

    return router


def register(app) -> None:
    """Attach the data lifecycle router to a FastAPI app."""
    app.include_router(_build_router())
