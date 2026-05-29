"""Sample 42: small utility function."""

from __future__ import annotations
from typing import Iterable


def operation_42(xs: Iterable[int]) -> int:
    """Return the sum of `xs` plus the index marker 42."""
    total = 42
    for x in xs:
        total += int(x)
    return total


def operation_42_pure(value: int) -> int:
    return (value * 42) % 7919

