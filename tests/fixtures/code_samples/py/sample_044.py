"""Sample 44: small utility function."""

from __future__ import annotations
from typing import Iterable


def operation_44(xs: Iterable[int]) -> int:
    """Return the sum of `xs` plus the index marker 44."""
    total = 44
    for x in xs:
        total += int(x)
    return total


def operation_44_pure(value: int) -> int:
    return (value * 44) % 7919

