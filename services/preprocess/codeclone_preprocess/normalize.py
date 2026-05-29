"""Normalization passes for training pairs."""

from __future__ import annotations

import re

from codeclone_dataset.pairs import Pair


_TAB_RE = re.compile(r"\t")
_TRAILING_WS_RE = re.compile(r"[ \t]+(\r?\n)")
_MANY_BLANK_RE = re.compile(r"\n{4,}")


def strip_trailing_ws(text: str) -> str:
    return _TRAILING_WS_RE.sub(r"\1", text)


def normalize_text(text: str) -> str:
    if not text:
        return text
    t = text.replace("\r\n", "\n").replace("\r", "\n")
    t = _TAB_RE.sub("    ", t)
    t = strip_trailing_ws(t)
    t = _MANY_BLANK_RE.sub("\n\n\n", t)
    return t


def normalize_pair(pair: Pair) -> Pair:
    """Return a normalized copy of `pair`."""
    return pair.model_copy(
        update={
            "prefix": normalize_text(pair.prefix),
            "completion": normalize_text(pair.completion),
        }
    )
