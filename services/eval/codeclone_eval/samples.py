"""Qualitative 'complete this commit' samples."""

from __future__ import annotations

import random
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

from codeclone_dataset.pairs import iter_pairs


@dataclass
class SampleRow:
    pair_id: str
    repo: str
    path: str
    language: str
    prefix: str
    gold: str
    prediction: str

    def to_dict(self) -> dict:
        return {
            "pair_id": self.pair_id,
            "repo": self.repo,
            "path": self.path,
            "language": self.language,
            "prefix": self.prefix,
            "gold": self.gold,
            "prediction": self.prediction,
        }


def _fallback_completer(prefix: str) -> str:
    return "# (no model loaded; sample-mode predictions disabled)\n"


def sample_completions(
    pairs_path: str | Path,
    completer: Callable[[str], str] | None = None,
    n: int = 4,
    seed: int = 1337,
) -> list[SampleRow]:
    pairs = list(iter_pairs(pairs_path))
    rng = random.Random(seed)
    picks = rng.sample(pairs, k=min(n, len(pairs))) if pairs else []
    cmpl = completer or _fallback_completer
    out: list[SampleRow] = []
    for p in picks:
        pred = cmpl(p.prefix)
        out.append(
            SampleRow(
                pair_id=p.id,
                repo=p.repo,
                path=p.path,
                language=p.language,
                prefix=p.prefix,
                gold=p.completion,
                prediction=pred,
            )
        )
    return out
