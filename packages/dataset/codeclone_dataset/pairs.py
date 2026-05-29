"""Pair schema and JSONL I/O."""

from __future__ import annotations

import json
from collections import Counter
from dataclasses import dataclass
from pathlib import Path
from typing import IO, Iterable, Iterator, Literal

import orjson
from pydantic import BaseModel, Field


PairKind = Literal["completion", "fill_in_middle", "instruction"]


class Pair(BaseModel):
    """A single training example.

    The pair represents the prefix the model will see and the completion it
    should learn to produce. For FIM examples, `prefix` may contain a sentinel
    like `<|fim_hole|>` matched by the trainer's tokenizer.
    """

    id: str
    kind: PairKind = "completion"
    language: str
    prefix: str
    completion: str
    # Provenance kept for auditability; never exposes private email beyond
    # what already appears on the public commit page.
    repo: str
    commit_sha: str
    path: str
    author_email_hash: str = Field(
        ..., description="sha256 of lowercased author email, first 16 hex chars"
    )
    n_prefix_chars: int = 0
    n_completion_chars: int = 0
    license: str | None = None

    def model_post_init(self, __ctx: object) -> None:  # type: ignore[override]
        if not self.n_prefix_chars:
            object.__setattr__(self, "n_prefix_chars", len(self.prefix))
        if not self.n_completion_chars:
            object.__setattr__(self, "n_completion_chars", len(self.completion))


def write_pairs(path: str | Path, pairs: Iterable[Pair]) -> int:
    """Write pairs to JSONL. Returns the count written. Creates parent dirs."""
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    count = 0
    with p.open("wb") as f:
        for pair in pairs:
            f.write(orjson.dumps(pair.model_dump()))
            f.write(b"\n")
            count += 1
    return count


def iter_pairs(path: str | Path) -> Iterator[Pair]:
    """Stream pairs from a JSONL file."""
    p = Path(path)
    with p.open("rb") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            data = orjson.loads(line)
            yield Pair.model_validate(data)


def read_pairs(path: str | Path) -> list[Pair]:
    return list(iter_pairs(path))


def _stream_dicts(f: IO[bytes]) -> Iterator[dict]:
    for line in f:
        line = line.strip()
        if not line:
            continue
        yield orjson.loads(line)


@dataclass
class PairStats:
    total: int
    by_language: dict[str, int]
    by_repo: dict[str, int]
    avg_prefix_chars: float
    avg_completion_chars: float
    p50_completion_chars: int
    p95_completion_chars: int

    def to_dict(self) -> dict:
        return {
            "total": self.total,
            "by_language": dict(sorted(self.by_language.items())),
            "by_repo": dict(sorted(self.by_repo.items())),
            "avg_prefix_chars": round(self.avg_prefix_chars, 1),
            "avg_completion_chars": round(self.avg_completion_chars, 1),
            "p50_completion_chars": self.p50_completion_chars,
            "p95_completion_chars": self.p95_completion_chars,
        }


def _percentile(values: list[int], q: float) -> int:
    if not values:
        return 0
    s = sorted(values)
    idx = max(0, min(len(s) - 1, int(round(q * (len(s) - 1)))))
    return s[idx]


def stats_for(pairs_path: str | Path) -> PairStats:
    """Compute summary stats over a JSONL of pairs without loading the whole list twice."""
    langs: Counter[str] = Counter()
    repos: Counter[str] = Counter()
    pref_total = 0
    comp_total = 0
    n = 0
    comp_lens: list[int] = []
    p = Path(pairs_path)
    with p.open("rb") as f:
        for d in _stream_dicts(f):
            n += 1
            langs[d.get("language", "unknown")] += 1
            repos[d.get("repo", "unknown")] += 1
            pref_total += int(d.get("n_prefix_chars", len(d.get("prefix", ""))))
            cl = int(d.get("n_completion_chars", len(d.get("completion", ""))))
            comp_total += cl
            comp_lens.append(cl)
    avg_prefix = pref_total / n if n else 0.0
    avg_comp = comp_total / n if n else 0.0
    return PairStats(
        total=n,
        by_language=dict(langs),
        by_repo=dict(repos),
        avg_prefix_chars=avg_prefix,
        avg_completion_chars=avg_comp,
        p50_completion_chars=_percentile(comp_lens, 0.5),
        p95_completion_chars=_percentile(comp_lens, 0.95),
    )
