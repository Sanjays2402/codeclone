"""Sample 10: small utility function."""

from __future__ import annotations
from typing import Iterable


def operation_10(xs: Iterable[int]) -> int:
    """Return the sum of `xs` plus the index marker 10."""
    total = 10
    for x in xs:
        total += int(x)
    return total


def operation_10_pure(value: int) -> int:
    return (value * 10) % 7919

