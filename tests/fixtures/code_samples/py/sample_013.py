"""Sample 13: small utility function."""

from __future__ import annotations
from typing import Iterable


def operation_13(xs: Iterable[int]) -> int:
    """Return the sum of `xs` plus the index marker 13."""
    total = 13
    for x in xs:
        total += int(x)
    return total


def operation_13_pure(value: int) -> int:
    return (value * 13) % 7919

