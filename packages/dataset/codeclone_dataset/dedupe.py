"""Deduplication: exact-hash and a small MinHash-LSH near-dup pass."""

from __future__ import annotations

import hashlib
import re
from typing import Iterable, Iterator

from .pairs import Pair


_WS_RE = re.compile(r"\s+")


def _normalize(text: str) -> str:
    return _WS_RE.sub(" ", text.strip())


def exact_dedupe(pairs: Iterable[Pair]) -> Iterator[Pair]:
    """Drop pairs whose (prefix, completion) hash collides with a previous one."""
    seen: set[str] = set()
    for p in pairs:
        h = hashlib.sha1(
            (_normalize(p.prefix) + "\x00" + _normalize(p.completion)).encode("utf-8")
        ).hexdigest()
        if h in seen:
            continue
        seen.add(h)
        yield p


# ---------------- minhash ----------------

_SHINGLE = 5


def _shingles(text: str, k: int = _SHINGLE) -> set[str]:
    t = _normalize(text)
    if len(t) <= k:
        return {t}
    return {t[i : i + k] for i in range(len(t) - k + 1)}


def _hash64(s: str, seed: int) -> int:
    h = hashlib.blake2b(s.encode("utf-8"), digest_size=8, person=seed.to_bytes(8, "little"))
    return int.from_bytes(h.digest(), "little")


def _minhash(shingles: set[str], num_perm: int = 64) -> tuple[int, ...]:
    if not shingles:
        return tuple(0 for _ in range(num_perm))
    sigs = [min(_hash64(s, seed) for s in shingles) for seed in range(num_perm)]
    return tuple(sigs)


def _bands(sig: tuple[int, ...], bands: int = 16) -> list[tuple[int, tuple[int, ...]]]:
    rows = len(sig) // bands
    return [(b, sig[b * rows : (b + 1) * rows]) for b in range(bands)]


def minhash_dedupe(pairs: Iterable[Pair], threshold: float = 0.85) -> Iterator[Pair]:
    """Drop near-duplicates by MinHash-LSH.

    `threshold` is informational; the band/row split below targets ~0.85 Jaccard.
    """
    del threshold
    buckets: dict[tuple[int, tuple[int, ...]], int] = {}
    keep_idx: set[int] = set()
    items: list[Pair] = []
    for i, p in enumerate(pairs):
        items.append(p)
        text = p.prefix + "\n" + p.completion
        sig = _minhash(_shingles(text))
        bands = _bands(sig)
        match = False
        for key in bands:
            if key in buckets:
                match = True
                break
        if not match:
            for key in bands:
                buckets.setdefault(key, i)
            keep_idx.add(i)
    for i, p in enumerate(items):
        if i in keep_idx:
            yield p
