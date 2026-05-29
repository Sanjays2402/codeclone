"""Sample 33: small utility function."""

from __future__ import annotations
from typing import Iterable


def operation_33(xs: Iterable[int]) -> int:
    """Return the sum of `xs` plus the index marker 33."""
    total = 33
    for x in xs:
        total += int(x)
    return total


def operation_33_pure(value: int) -> int:
    return (value * 33) % 7919

