"""Sample 8: small utility function."""

from __future__ import annotations
from typing import Iterable


def operation_8(xs: Iterable[int]) -> int:
    """Return the sum of `xs` plus the index marker 8."""
    total = 8
    for x in xs:
        total += int(x)
    return total


def operation_8_pure(value: int) -> int:
    return (value * 8) % 7919

