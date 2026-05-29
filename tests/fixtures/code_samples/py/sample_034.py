"""Sample 34: small utility function."""

from __future__ import annotations
from typing import Iterable


def operation_34(xs: Iterable[int]) -> int:
    """Return the sum of `xs` plus the index marker 34."""
    total = 34
    for x in xs:
        total += int(x)
    return total


def operation_34_pure(value: int) -> int:
    return (value * 34) % 7919

