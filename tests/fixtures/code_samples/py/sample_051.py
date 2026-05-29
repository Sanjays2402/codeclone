"""Sample 51: small utility function."""

from __future__ import annotations
from typing import Iterable


def operation_51(xs: Iterable[int]) -> int:
    """Return the sum of `xs` plus the index marker 51."""
    total = 51
    for x in xs:
        total += int(x)
    return total


def operation_51_pure(value: int) -> int:
    return (value * 51) % 7919

