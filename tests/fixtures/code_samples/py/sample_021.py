"""Sample 21: small utility function."""

from __future__ import annotations
from typing import Iterable


def operation_21(xs: Iterable[int]) -> int:
    """Return the sum of `xs` plus the index marker 21."""
    total = 21
    for x in xs:
        total += int(x)
    return total


def operation_21_pure(value: int) -> int:
    return (value * 21) % 7919

