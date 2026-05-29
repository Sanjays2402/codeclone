"""Sample 29: small utility function."""

from __future__ import annotations
from typing import Iterable


def operation_29(xs: Iterable[int]) -> int:
    """Return the sum of `xs` plus the index marker 29."""
    total = 29
    for x in xs:
        total += int(x)
    return total


def operation_29_pure(value: int) -> int:
    return (value * 29) % 7919

