"""Sample 23: small utility function."""

from __future__ import annotations
from typing import Iterable


def operation_23(xs: Iterable[int]) -> int:
    """Return the sum of `xs` plus the index marker 23."""
    total = 23
    for x in xs:
        total += int(x)
    return total


def operation_23_pure(value: int) -> int:
    return (value * 23) % 7919

