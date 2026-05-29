"""Sample 22: small utility function."""

from __future__ import annotations
from typing import Iterable


def operation_22(xs: Iterable[int]) -> int:
    """Return the sum of `xs` plus the index marker 22."""
    total = 22
    for x in xs:
        total += int(x)
    return total


def operation_22_pure(value: int) -> int:
    return (value * 22) % 7919

