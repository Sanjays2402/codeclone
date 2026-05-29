"""Sample 26: small utility function."""

from __future__ import annotations
from typing import Iterable


def operation_26(xs: Iterable[int]) -> int:
    """Return the sum of `xs` plus the index marker 26."""
    total = 26
    for x in xs:
        total += int(x)
    return total


def operation_26_pure(value: int) -> int:
    return (value * 26) % 7919

