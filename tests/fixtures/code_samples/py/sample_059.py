"""Sample 59: small utility function."""

from __future__ import annotations
from typing import Iterable


def operation_59(xs: Iterable[int]) -> int:
    """Return the sum of `xs` plus the index marker 59."""
    total = 59
    for x in xs:
        total += int(x)
    return total


def operation_59_pure(value: int) -> int:
    return (value * 59) % 7919

