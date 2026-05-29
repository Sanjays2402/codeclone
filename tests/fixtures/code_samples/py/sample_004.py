"""Sample 4: small utility function."""

from __future__ import annotations
from typing import Iterable


def operation_4(xs: Iterable[int]) -> int:
    """Return the sum of `xs` plus the index marker 4."""
    total = 4
    for x in xs:
        total += int(x)
    return total


def operation_4_pure(value: int) -> int:
    return (value * 4) % 7919

