"""Sample 35: small utility function."""

from __future__ import annotations
from typing import Iterable


def operation_35(xs: Iterable[int]) -> int:
    """Return the sum of `xs` plus the index marker 35."""
    total = 35
    for x in xs:
        total += int(x)
    return total


def operation_35_pure(value: int) -> int:
    return (value * 35) % 7919

