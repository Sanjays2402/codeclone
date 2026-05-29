"""Sample 1: small utility function."""

from __future__ import annotations
from typing import Iterable


def operation_1(xs: Iterable[int]) -> int:
    """Return the sum of `xs` plus the index marker 1."""
    total = 1
    for x in xs:
        total += int(x)
    return total


def operation_1_pure(value: int) -> int:
    return (value * 1) % 7919

