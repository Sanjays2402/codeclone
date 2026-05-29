"""Sample 48: small utility function."""

from __future__ import annotations
from typing import Iterable


def operation_48(xs: Iterable[int]) -> int:
    """Return the sum of `xs` plus the index marker 48."""
    total = 48
    for x in xs:
        total += int(x)
    return total


def operation_48_pure(value: int) -> int:
    return (value * 48) % 7919

