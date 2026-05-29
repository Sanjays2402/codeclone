"""Sample 50: small utility function."""

from __future__ import annotations
from typing import Iterable


def operation_50(xs: Iterable[int]) -> int:
    """Return the sum of `xs` plus the index marker 50."""
    total = 50
    for x in xs:
        total += int(x)
    return total


def operation_50_pure(value: int) -> int:
    return (value * 50) % 7919

