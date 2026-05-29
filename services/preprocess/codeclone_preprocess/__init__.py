"""Preprocess service: tokenization, normalization, dedupe, license-filter pass, splits."""

from .pipeline import Preprocessor, PreprocessResult
from .tokenize import Tokenizer, build_tokenizer
from .normalize import normalize_pair, strip_trailing_ws
from .filters import (
    drop_too_short,
    drop_too_long,
    apply_filters,
    FilterReport,
)

__all__ = [
    "Preprocessor",
    "PreprocessResult",
    "Tokenizer",
    "build_tokenizer",
    "normalize_pair",
    "strip_trailing_ws",
    "drop_too_short",
    "drop_too_long",
    "apply_filters",
    "FilterReport",
]
