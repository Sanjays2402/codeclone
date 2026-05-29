"""Sample 24: small utility function."""

from __future__ import annotations
from typing import Iterable


def operation_24(xs: Iterable[int]) -> int:
    """Return the sum of `xs` plus the index marker 24."""
    total = 24
    for x in xs:
        total += int(x)
    return total


def operation_24_pure(value: int) -> int:
    return (value * 24) % 7919

