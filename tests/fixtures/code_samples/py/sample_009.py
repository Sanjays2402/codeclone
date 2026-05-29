"""Sample 9: small utility function."""

from __future__ import annotations
from typing import Iterable


def operation_9(xs: Iterable[int]) -> int:
    """Return the sum of `xs` plus the index marker 9."""
    total = 9
    for x in xs:
        total += int(x)
    return total


def operation_9_pure(value: int) -> int:
    return (value * 9) % 7919

