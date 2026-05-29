"""Tokenizer wrapper. Uses HF `tokenizers` when available, falls back to tiktoken."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol


class TokenizerLike(Protocol):
    def encode(self, text: str) -> list[int]: ...
    def decode(self, ids: list[int]) -> str: ...


@dataclass
class Tokenizer:
    impl: TokenizerLike
    name: str

    def encode(self, text: str) -> list[int]:
        return self.impl.encode(text)

    def decode(self, ids: list[int]) -> str:
        return self.impl.decode(ids)

    def count(self, text: str) -> int:
        return len(self.encode(text))


class _HFAdapter:
    def __init__(self, hf_tok) -> None:  # type: ignore[no-untyped-def]
        self._t = hf_tok

    def encode(self, text: str) -> list[int]:
        # tokenizers.Tokenizer
        if hasattr(self._t, "encode") and hasattr(self._t, "decode"):
            enc = self._t.encode(text)
            if hasattr(enc, "ids"):
                return list(enc.ids)
            return list(enc)
        return []  # pragma: no cover

    def decode(self, ids: list[int]) -> str:
        return self._t.decode(ids)


class _TiktokenAdapter:
    def __init__(self, enc) -> None:  # type: ignore[no-untyped-def]
        self._enc = enc

    def encode(self, text: str) -> list[int]:
        return self._enc.encode(text)

    def decode(self, ids: list[int]) -> str:
        return self._enc.decode(ids)


def build_tokenizer(name_or_path: str) -> Tokenizer:
    """Try HF first (`tokenizers` or `transformers`), then fall back to tiktoken
    with `cl100k_base` (a reasonable code-leaning default for byte counting).
    """
    # 1. tokenizers JSON / repo
    try:
        from tokenizers import Tokenizer as HFTokenizer  # type: ignore

        try:
            tok = HFTokenizer.from_pretrained(name_or_path)
            return Tokenizer(impl=_HFAdapter(tok), name=name_or_path)
        except Exception:
            pass
    except ImportError:
        pass

    # 2. transformers AutoTokenizer
    try:
        from transformers import AutoTokenizer  # type: ignore

        tok = AutoTokenizer.from_pretrained(name_or_path, use_fast=True)
        return Tokenizer(impl=_HFAdapter(tok), name=name_or_path)
    except Exception:
        pass

    # 3. tiktoken
    import tiktoken

    enc = tiktoken.get_encoding("cl100k_base")
    return Tokenizer(impl=_TiktokenAdapter(enc), name="tiktoken/cl100k_base")
