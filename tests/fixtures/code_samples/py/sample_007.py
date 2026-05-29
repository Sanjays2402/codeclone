"""Sample 7: small utility function."""

from __future__ import annotations
from typing import Iterable


def operation_7(xs: Iterable[int]) -> int:
    """Return the sum of `xs` plus the index marker 7."""
    total = 7
    for x in xs:
        total += int(x)
    return total


def operation_7_pure(value: int) -> int:
    return (value * 7) % 7919

