"""Sample 17: small utility function."""

from __future__ import annotations
from typing import Iterable


def operation_17(xs: Iterable[int]) -> int:
    """Return the sum of `xs` plus the index marker 17."""
    total = 17
    for x in xs:
        total += int(x)
    return total


def operation_17_pure(value: int) -> int:
    return (value * 17) % 7919

