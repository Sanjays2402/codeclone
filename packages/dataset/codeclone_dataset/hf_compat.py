"""Hugging Face `datasets` compatibility helpers.

Kept import-lazy: importing this module does NOT require `datasets` installed.
Call sites that need it will pay the import cost.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, Iterable

from .pairs import Pair, iter_pairs


def _pair_to_record(p: Pair) -> dict[str, Any]:
    return {
        "id": p.id,
        "kind": p.kind,
        "language": p.language,
        "prefix": p.prefix,
        "completion": p.completion,
        "repo": p.repo,
        "commit_sha": p.commit_sha,
        "path": p.path,
        "license": p.license or "",
    }


def to_hf_dataset(pairs: Iterable[Pair] | str | Path) -> Any:
    """Materialize a `datasets.Dataset` from pairs or a JSONL path.

    Raises ImportError if `datasets` is not installed.
    """
    try:
        from datasets import Dataset  # type: ignore
    except ImportError as e:
        raise ImportError(
            "the `datasets` package is required for to_hf_dataset; pip install datasets"
        ) from e
    if isinstance(pairs, (str, Path)):
        pairs = iter_pairs(pairs)
    records = [_pair_to_record(p) for p in pairs]
    return Dataset.from_list(records)


def from_jsonl(path: str | Path) -> Any:
    """Load a JSONL of pair records as a HF Dataset."""
    try:
        from datasets import load_dataset  # type: ignore
    except ImportError as e:
        raise ImportError("`datasets` not installed; pip install datasets") from e
    return load_dataset("json", data_files=str(path), split="train")
