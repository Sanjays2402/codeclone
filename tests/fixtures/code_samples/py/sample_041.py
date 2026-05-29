"""Sample 41: small utility function."""

from __future__ import annotations
from typing import Iterable


def operation_41(xs: Iterable[int]) -> int:
    """Return the sum of `xs` plus the index marker 41."""
    total = 41
    for x in xs:
        total += int(x)
    return total


def operation_41_pure(value: int) -> int:
    return (value * 41) % 7919

