"""Filesystem helpers (atomic writes, safe path joins)."""

from __future__ import annotations

import os
import tempfile
from pathlib import Path


def atomic_write_text(path: str | Path, text: str, encoding: str = "utf-8") -> None:
    """Write `text` to `path` atomically (write+rename in same dir).

    Crash-safe; readers always see either the prior contents or the new ones.
    """
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = tempfile.NamedTemporaryFile(
        "w", encoding=encoding, dir=str(p.parent), delete=False, prefix=".tmp-", suffix=p.name
    )
    try:
        tmp.write(text)
        tmp.flush()
        os.fsync(tmp.fileno())
    finally:
        tmp.close()
    os.replace(tmp.name, p)


def ensure_dir(path: str | Path) -> Path:
    p = Path(path)
    p.mkdir(parents=True, exist_ok=True)
    return p


def human_bytes(n: int) -> str:
    units = ["B", "KiB", "MiB", "GiB", "TiB"]
    f = float(n)
    for u in units:
        if f < 1024.0:
            return f"{f:.1f} {u}"
        f /= 1024.0
    return f"{f:.1f} PiB"
