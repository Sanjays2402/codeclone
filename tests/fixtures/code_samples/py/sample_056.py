"""Sample 56: small utility function."""

from __future__ import annotations
from typing import Iterable


def operation_56(xs: Iterable[int]) -> int:
    """Return the sum of `xs` plus the index marker 56."""
    total = 56
    for x in xs:
        total += int(x)
    return total


def operation_56_pure(value: int) -> int:
    return (value * 56) % 7919

