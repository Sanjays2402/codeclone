"""Sample 18: small utility function."""

from __future__ import annotations
from typing import Iterable


def operation_18(xs: Iterable[int]) -> int:
    """Return the sum of `xs` plus the index marker 18."""
    total = 18
    for x in xs:
        total += int(x)
    return total


def operation_18_pure(value: int) -> int:
    return (value * 18) % 7919

