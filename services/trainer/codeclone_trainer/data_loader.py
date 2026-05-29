"""Iterate JSONL pairs into TrainBatch chunks for backends."""

from __future__ import annotations

import random
from dataclasses import dataclass
from pathlib import Path
from typing import Iterator

from codeclone_dataset.pairs import Pair, iter_pairs

from .backends.base import TrainBatch


def format_for_training(p: Pair) -> tuple[str, str]:
    """Render a pair as (input_text, target_text).

    The prefix is kept as-is (already includes provenance comments). The model
    learns to emit `completion` given that context. For FIM pairs in the
    future, this function is the right place to insert sentinels.
    """
    return p.prefix, p.completion


@dataclass
class JsonlPairLoader:
    path: Path
    batch_size: int = 4
    seed: int = 1337
    shuffle: bool = True
    max_pairs: int | None = None

    def __iter__(self) -> Iterator[TrainBatch]:
        return self.iter_batches()

    def iter_batches(self) -> Iterator[TrainBatch]:
        pairs: list[Pair] = list(iter_pairs(self.path))
        if self.max_pairs is not None:
            pairs = pairs[: self.max_pairs]
        if self.shuffle:
            rng = random.Random(self.seed)
            rng.shuffle(pairs)
        buf_in: list[str] = []
        buf_out: list[str] = []
        for p in pairs:
            i, t = format_for_training(p)
            buf_in.append(i)
            buf_out.append(t)
            if len(buf_in) == self.batch_size:
                yield TrainBatch(inputs=buf_in, targets=buf_out)
                buf_in, buf_out = [], []
        if buf_in:
            yield TrainBatch(inputs=buf_in, targets=buf_out)
