"""Tests for size-based audit log rotation and gzip retention.

Verifies that ``AuditSink``:
- rotates the live JSONL file once it crosses ``max_bytes``
- gzips the rotated file with a UTC timestamp suffix
- prunes the oldest backups beyond ``backup_count``
- preserves every audit row across rotations (no data loss)
- treats ``max_bytes=0`` as the legacy never-rotate mode
"""

from __future__ import annotations

import gzip
import json
import time
from pathlib import Path

import pytest
from codeclone_serve.audit import AuditSink, build_sink_from_env


def _drain(sink: AuditSink, timeout: float = 2.0) -> None:
    sink.flush(timeout=timeout)
    # ``flush`` only waits for the queue to drain; give the writer a tick to
    # finish the current rotation cycle before we inspect the directory.
    time.sleep(0.05)


def _all_rows(path: Path) -> list[dict]:
    rows: list[dict] = []
    backups = sorted(
        path.parent.glob(f"{path.name}.*.gz"), key=lambda p: p.stat().st_mtime
    )
    for backup in backups:
        with gzip.open(backup, "rt", encoding="utf-8") as fh:
            rows.extend(json.loads(line) for line in fh if line.strip())
    if path.exists():
        rows.extend(
            json.loads(line)
            for line in path.read_text(encoding="utf-8").splitlines()
            if line.strip()
        )
    return rows


def test_rotation_creates_gzip_backup_and_preserves_rows(tmp_path: Path) -> None:
    log_path = tmp_path / "audit.log"
    # Tiny max_bytes so a handful of records forces multiple rotations.
    sink = AuditSink(log_path, max_bytes=512, backup_count=50)
    try:
        for i in range(40):
            sink.write({"i": i, "pad": "x" * 80})
        _drain(sink)
    finally:
        sink.close()

    backups = list(log_path.parent.glob("audit.log.*.gz"))
    assert backups, "expected at least one gzip-rotated backup"
    for b in backups:
        # Gzip header magic bytes; verify the file is actually compressed.
        assert b.read_bytes()[:2] == b"\x1f\x8b"

    rows = _all_rows(log_path)
    assert [r["i"] for r in rows] == list(range(40)), (
        "rotation must not drop or reorder audit rows"
    )


def test_rotation_prunes_old_backups_beyond_retention(tmp_path: Path) -> None:
    log_path = tmp_path / "audit.log"
    sink = AuditSink(log_path, max_bytes=256, backup_count=2)
    try:
        for i in range(60):
            sink.write({"i": i, "pad": "y" * 60})
        _drain(sink)
    finally:
        sink.close()

    backups = list(log_path.parent.glob("audit.log.*.gz"))
    assert len(backups) <= 2, (
        f"backup_count=2 should cap retained gzip files, got {len(backups)}"
    )
    assert backups, "expected rotation to have produced gzip backups"


def test_rotation_disabled_when_max_bytes_zero(tmp_path: Path) -> None:
    log_path = tmp_path / "audit.log"
    sink = AuditSink(log_path, max_bytes=0, backup_count=0)
    try:
        for i in range(50):
            sink.write({"i": i, "pad": "z" * 200})
        _drain(sink)
    finally:
        sink.close()

    backups = list(log_path.parent.glob("audit.log.*.gz"))
    assert not backups, "max_bytes=0 must keep legacy single-file behavior"
    rows = [
        json.loads(line)
        for line in log_path.read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]
    assert [r["i"] for r in rows] == list(range(50))


def test_build_sink_from_env_reads_rotation_knobs(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    log_path = tmp_path / "audit.log"
    monkeypatch.setenv("CODECLONE_AUDIT_LOG_PATH", str(log_path))
    monkeypatch.setenv("CODECLONE_AUDIT_LOG_MAX_BYTES", "1024")
    monkeypatch.setenv("CODECLONE_AUDIT_LOG_BACKUP_COUNT", "3")

    sink = build_sink_from_env(tmp_path / "fallback.log")
    try:
        assert sink.path == log_path
        assert sink.max_bytes == 1024
        assert sink.backup_count == 3
    finally:
        sink.close()


def test_build_sink_from_env_invalid_values_fall_back_to_defaults(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("CODECLONE_AUDIT_LOG_PATH", str(tmp_path / "audit.log"))
    monkeypatch.setenv("CODECLONE_AUDIT_LOG_MAX_BYTES", "not-an-int")
    monkeypatch.setenv("CODECLONE_AUDIT_LOG_BACKUP_COUNT", "-7")

    sink = build_sink_from_env(tmp_path / "fallback.log")
    try:
        # Defaults documented in build_sink_from_env: 50 MiB / 14 backups.
        assert sink.max_bytes == 50 * 1024 * 1024
        assert sink.backup_count == 14
    finally:
        sink.close()
