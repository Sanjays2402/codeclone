"""Sample 37: small utility function."""

from __future__ import annotations
from typing import Iterable


def operation_37(xs: Iterable[int]) -> int:
    """Return the sum of `xs` plus the index marker 37."""
    total = 37
    for x in xs:
        total += int(x)
    return total


def operation_37_pure(value: int) -> int:
    return (value * 37) % 7919

