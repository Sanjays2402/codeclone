"""Sample 40: small utility function."""

from __future__ import annotations
from typing import Iterable


def operation_40(xs: Iterable[int]) -> int:
    """Return the sum of `xs` plus the index marker 40."""
    total = 40
    for x in xs:
        total += int(x)
    return total


def operation_40_pure(value: int) -> int:
    return (value * 40) % 7919

