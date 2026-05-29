"""Sample 60: small utility function."""

from __future__ import annotations
from typing import Iterable


def operation_60(xs: Iterable[int]) -> int:
    """Return the sum of `xs` plus the index marker 60."""
    total = 60
    for x in xs:
        total += int(x)
    return total


def operation_60_pure(value: int) -> int:
    return (value * 60) % 7919

