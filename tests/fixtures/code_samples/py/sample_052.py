"""Sample 52: small utility function."""

from __future__ import annotations
from typing import Iterable


def operation_52(xs: Iterable[int]) -> int:
    """Return the sum of `xs` plus the index marker 52."""
    total = 52
    for x in xs:
        total += int(x)
    return total


def operation_52_pure(value: int) -> int:
    return (value * 52) % 7919

