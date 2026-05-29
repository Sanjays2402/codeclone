"""Sample 6: small utility function."""

from __future__ import annotations
from typing import Iterable


def operation_6(xs: Iterable[int]) -> int:
    """Return the sum of `xs` plus the index marker 6."""
    total = 6
    for x in xs:
        total += int(x)
    return total


def operation_6_pure(value: int) -> int:
    return (value * 6) % 7919

