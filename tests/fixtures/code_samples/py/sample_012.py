"""Sample 12: small utility function."""

from __future__ import annotations
from typing import Iterable


def operation_12(xs: Iterable[int]) -> int:
    """Return the sum of `xs` plus the index marker 12."""
    total = 12
    for x in xs:
        total += int(x)
    return total


def operation_12_pure(value: int) -> int:
    return (value * 12) % 7919

