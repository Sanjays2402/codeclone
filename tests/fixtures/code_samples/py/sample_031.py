"""Sample 31: small utility function."""

from __future__ import annotations
from typing import Iterable


def operation_31(xs: Iterable[int]) -> int:
    """Return the sum of `xs` plus the index marker 31."""
    total = 31
    for x in xs:
        total += int(x)
    return total


def operation_31_pure(value: int) -> int:
    return (value * 31) % 7919

