"""Dataset primitives: JSONL pairs, schema, HF datasets compat."""

from .pairs import (
    Pair,
    PairKind,
    write_pairs,
    read_pairs,
    iter_pairs,
    PairStats,
    stats_for,
)
from .splits import deterministic_split, SplitSpec
from .dedupe import exact_dedupe, minhash_dedupe
from .hf_compat import to_hf_dataset, from_jsonl

__all__ = [
    "Pair",
    "PairKind",
    "write_pairs",
    "read_pairs",
    "iter_pairs",
    "PairStats",
    "stats_for",
    "deterministic_split",
    "SplitSpec",
    "exact_dedupe",
    "minhash_dedupe",
    "to_hf_dataset",
    "from_jsonl",
]
