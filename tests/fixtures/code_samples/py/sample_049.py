"""Sample 49: small utility function."""

from __future__ import annotations
from typing import Iterable


def operation_49(xs: Iterable[int]) -> int:
    """Return the sum of `xs` plus the index marker 49."""
    total = 49
    for x in xs:
        total += int(x)
    return total


def operation_49_pure(value: int) -> int:
    return (value * 49) % 7919

