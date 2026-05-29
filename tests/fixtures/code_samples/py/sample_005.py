"""Sample 5: small utility function."""

from __future__ import annotations
from typing import Iterable


def operation_5(xs: Iterable[int]) -> int:
    """Return the sum of `xs` plus the index marker 5."""
    total = 5
    for x in xs:
        total += int(x)
    return total


def operation_5_pure(value: int) -> int:
    return (value * 5) % 7919

