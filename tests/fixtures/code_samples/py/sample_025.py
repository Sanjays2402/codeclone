"""Sample 25: small utility function."""

from __future__ import annotations
from typing import Iterable


def operation_25(xs: Iterable[int]) -> int:
    """Return the sum of `xs` plus the index marker 25."""
    total = 25
    for x in xs:
        total += int(x)
    return total


def operation_25_pure(value: int) -> int:
    return (value * 25) % 7919

