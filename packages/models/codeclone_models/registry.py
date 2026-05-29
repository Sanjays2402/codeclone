"""Checkpoint registry. A simple on-disk JSON index over `adapters/`."""

from __future__ import annotations

import json
import shutil
from dataclasses import dataclass, field, asdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


@dataclass
class CheckpointMeta:
    name: str
    base_model: str
    backend: str
    recipe_hash: str
    created_at: str
    n_train_pairs: int = 0
    n_val_pairs: int = 0
    final_train_loss: float | None = None
    final_val_loss: float | None = None
    seed: int = 1337
    tags: list[str] = field(default_factory=list)
    extra: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


class CheckpointRegistry:
    """Manage adapters/<name>/ directories with a `meta.json` per checkpoint
    and a top-level `index.json` for fast listing.
    """

    INDEX_NAME = "index.json"
    META_NAME = "meta.json"

    def __init__(self, root: str | Path) -> None:
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)

    # ---------- low level ----------

    def _index_path(self) -> Path:
        return self.root / self.INDEX_NAME

    def _meta_path(self, name: str) -> Path:
        return self.root / name / self.META_NAME

    def _read_index(self) -> dict[str, dict[str, Any]]:
        p = self._index_path()
        if not p.exists():
            return {}
        return json.loads(p.read_text("utf-8"))

    def _write_index(self, idx: dict[str, dict[str, Any]]) -> None:
        self._index_path().write_text(
            json.dumps(idx, indent=2, sort_keys=True), encoding="utf-8"
        )

    # ---------- public ----------

    def list(self) -> list[CheckpointMeta]:
        """List all known checkpoints. Falls back to scanning the filesystem
        if index.json is missing or stale.
        """
        out: list[CheckpointMeta] = []
        seen: set[str] = set()
        for name, meta in self._read_index().items():
            try:
                out.append(CheckpointMeta(**meta))
                seen.add(name)
            except Exception:
                continue
        # Walk filesystem for anything index missed.
        for child in self.root.iterdir():
            if not child.is_dir():
                continue
            if child.name in seen:
                continue
            mp = child / self.META_NAME
            if mp.exists():
                try:
                    out.append(CheckpointMeta(**json.loads(mp.read_text("utf-8"))))
                except Exception:
                    pass
        out.sort(key=lambda m: m.created_at, reverse=True)
        return out

    def get(self, name: str) -> CheckpointMeta | None:
        mp = self._meta_path(name)
        if not mp.exists():
            return None
        return CheckpointMeta(**json.loads(mp.read_text("utf-8")))

    def path(self, name: str) -> Path:
        return self.root / name

    def register(self, meta: CheckpointMeta) -> Path:
        """Create the adapter directory (if missing) and write metadata."""
        adir = self.root / meta.name
        adir.mkdir(parents=True, exist_ok=True)
        (adir / self.META_NAME).write_text(
            json.dumps(meta.to_dict(), indent=2, sort_keys=True), encoding="utf-8"
        )
        idx = self._read_index()
        idx[meta.name] = meta.to_dict()
        self._write_index(idx)
        return adir

    def update(self, name: str, **fields: Any) -> CheckpointMeta:
        meta = self.get(name)
        if meta is None:
            raise KeyError(f"unknown checkpoint: {name}")
        data = meta.to_dict()
        data.update(fields)
        new = CheckpointMeta(**data)
        self.register(new)
        return new

    def delete(self, name: str) -> bool:
        adir = self.root / name
        if not adir.exists():
            return False
        shutil.rmtree(adir)
        idx = self._read_index()
        idx.pop(name, None)
        self._write_index(idx)
        return True

    @staticmethod
    def now_iso() -> str:
        return datetime.now(timezone.utc).isoformat(timespec="seconds")
