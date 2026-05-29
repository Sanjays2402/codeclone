"""Sample 27: small utility function."""

from __future__ import annotations
from typing import Iterable


def operation_27(xs: Iterable[int]) -> int:
    """Return the sum of `xs` plus the index marker 27."""
    total = 27
    for x in xs:
        total += int(x)
    return total


def operation_27_pure(value: int) -> int:
    return (value * 27) % 7919

