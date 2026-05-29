"""Deterministic train/val/test splits."""

from __future__ import annotations

import random
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

from .pairs import Pair, write_pairs, iter_pairs


@dataclass
class SplitSpec:
    train: float
    val: float
    test: float
    seed: int = 42

    def validate(self) -> None:
        total = self.train + self.val + self.test
        if not (0.99 <= total <= 1.01):
            raise ValueError(
                f"split fractions must sum to ~1.0, got {total} ({self.train}/{self.val}/{self.test})"
            )
        for label, v in (("train", self.train), ("val", self.val), ("test", self.test)):
            if not 0.0 <= v <= 1.0:
                raise ValueError(f"{label} fraction must be in [0,1], got {v}")


def deterministic_split(
    pairs: Iterable[Pair] | str | Path,
    out_dir: str | Path,
    spec: SplitSpec,
) -> dict[str, int]:
    """Materialize train/val/test JSONLs under `out_dir`.

    Shuffles by `spec.seed`. Returns a count dict.
    Splitting uses index buckets so the same input always lands the same way.
    """
    spec.validate()
    if isinstance(pairs, (str, Path)):
        items = list(iter_pairs(pairs))
    else:
        items = list(pairs)

    rng = random.Random(spec.seed)
    indices = list(range(len(items)))
    rng.shuffle(indices)
    shuffled = [items[i] for i in indices]

    n = len(shuffled)
    n_train = int(round(n * spec.train))
    n_val = int(round(n * spec.val))
    n_train = min(n_train, n)
    n_val = min(n_val, n - n_train)
    # Test gets the remainder so counts sum exactly.
    n_test = n - n_train - n_val

    train = shuffled[:n_train]
    val = shuffled[n_train : n_train + n_val]
    test = shuffled[n_train + n_val :]
    assert len(test) == n_test

    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    counts = {
        "train": write_pairs(out / "train.jsonl", train),
        "val": write_pairs(out / "val.jsonl", val),
        "test": write_pairs(out / "test.jsonl", test),
    }
    return counts
