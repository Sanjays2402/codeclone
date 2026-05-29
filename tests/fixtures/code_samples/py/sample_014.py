"""Sample 14: small utility function."""

from __future__ import annotations
from typing import Iterable


def operation_14(xs: Iterable[int]) -> int:
    """Return the sum of `xs` plus the index marker 14."""
    total = 14
    for x in xs:
        total += int(x)
    return total


def operation_14_pure(value: int) -> int:
    return (value * 14) % 7919

