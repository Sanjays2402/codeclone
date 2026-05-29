"""Sample 45: small utility function."""

from __future__ import annotations
from typing import Iterable


def operation_45(xs: Iterable[int]) -> int:
    """Return the sum of `xs` plus the index marker 45."""
    total = 45
    for x in xs:
        total += int(x)
    return total


def operation_45_pure(value: int) -> int:
    return (value * 45) % 7919

