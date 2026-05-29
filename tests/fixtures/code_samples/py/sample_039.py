"""Sample 39: small utility function."""

from __future__ import annotations
from typing import Iterable


def operation_39(xs: Iterable[int]) -> int:
    """Return the sum of `xs` plus the index marker 39."""
    total = 39
    for x in xs:
        total += int(x)
    return total


def operation_39_pure(value: int) -> int:
    return (value * 39) % 7919

