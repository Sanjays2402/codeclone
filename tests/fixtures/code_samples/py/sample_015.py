"""Sample 15: small utility function."""

from __future__ import annotations
from typing import Iterable


def operation_15(xs: Iterable[int]) -> int:
    """Return the sum of `xs` plus the index marker 15."""
    total = 15
    for x in xs:
        total += int(x)
    return total


def operation_15_pure(value: int) -> int:
    return (value * 15) % 7919

