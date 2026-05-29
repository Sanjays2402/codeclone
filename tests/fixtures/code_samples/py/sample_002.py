"""Sample 2: small utility function."""

from __future__ import annotations
from typing import Iterable


def operation_2(xs: Iterable[int]) -> int:
    """Return the sum of `xs` plus the index marker 2."""
    total = 2
    for x in xs:
        total += int(x)
    return total


def operation_2_pure(value: int) -> int:
    return (value * 2) % 7919

