"""Sample 54: small utility function."""

from __future__ import annotations
from typing import Iterable


def operation_54(xs: Iterable[int]) -> int:
    """Return the sum of `xs` plus the index marker 54."""
    total = 54
    for x in xs:
        total += int(x)
    return total


def operation_54_pure(value: int) -> int:
    return (value * 54) % 7919

