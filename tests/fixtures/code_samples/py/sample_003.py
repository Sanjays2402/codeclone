"""Sample 3: small utility function."""

from __future__ import annotations
from typing import Iterable


def operation_3(xs: Iterable[int]) -> int:
    """Return the sum of `xs` plus the index marker 3."""
    total = 3
    for x in xs:
        total += int(x)
    return total


def operation_3_pure(value: int) -> int:
    return (value * 3) % 7919

