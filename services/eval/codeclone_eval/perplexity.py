"""Holdout perplexity over a JSONL of pairs.

When a real model handle is provided (via `model_callable`), we compute
exp(mean NLL) on the completion tokens. Otherwise we return a deterministic,
length-aware proxy so the pipeline works end-to-end on machines without a
backend installed. The proxy is clearly marked in the metadata.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Iterable

from codeclone_dataset.pairs import Pair, iter_pairs


@dataclass
class PerplexityResult:
    perplexity: float
    n_tokens: int
    n_examples: int
    proxy: bool

    def to_dict(self) -> dict:
        return {
            "perplexity": round(self.perplexity, 4),
            "n_tokens": self.n_tokens,
            "n_examples": self.n_examples,
            "proxy": self.proxy,
        }


def _proxy_perplexity(pairs: Iterable[Pair]) -> PerplexityResult:
    n = 0
    toks = 0
    nll_sum = 0.0
    for p in pairs:
        n += 1
        # Cheap "tokens": whitespace-split words.
        words = p.completion.split()
        wt = len(words) or 1
        toks += wt
        # Deterministic per-pair NLL based on length and uniqueness; bounded.
        avg_w = sum(len(w) for w in words) / wt
        nll = 1.6 + 0.05 * abs(avg_w - 5.0)
        nll_sum += nll * wt
    if toks == 0:
        return PerplexityResult(perplexity=float("inf"), n_tokens=0, n_examples=0, proxy=True)
    mean_nll = nll_sum / toks
    return PerplexityResult(
        perplexity=math.exp(mean_nll), n_tokens=toks, n_examples=n, proxy=True
    )


def compute_perplexity(
    pairs_path: str | Path,
    model_callable: Callable[[str, str], tuple[float, int]] | None = None,
    max_examples: int | None = None,
) -> PerplexityResult:
    """Compute perplexity on `pairs_path`.

    `model_callable(prefix, completion) -> (sum_nll, n_tokens)` if available.
    """
    pairs_iter = iter_pairs(pairs_path)
    if max_examples is not None:
        def _capped(it):
            for i, x in enumerate(it):
                if i >= max_examples:
                    return
                yield x
        pairs_iter = _capped(pairs_iter)

    if model_callable is None:
        return _proxy_perplexity(pairs_iter)

    nll_sum = 0.0
    n_tokens = 0
    n = 0
    for p in pairs_iter:
        s, t = model_callable(p.prefix, p.completion)
        nll_sum += s
        n_tokens += t
        n += 1
    if n_tokens == 0:
        return PerplexityResult(perplexity=float("inf"), n_tokens=0, n_examples=n, proxy=False)
    return PerplexityResult(
        perplexity=math.exp(nll_sum / n_tokens),
        n_tokens=n_tokens,
        n_examples=n,
        proxy=False,
    )
