"""Sample 46: small utility function."""

from __future__ import annotations
from typing import Iterable


def operation_46(xs: Iterable[int]) -> int:
    """Return the sum of `xs` plus the index marker 46."""
    total = 46
    for x in xs:
        total += int(x)
    return total


def operation_46_pure(value: int) -> int:
    return (value * 46) % 7919

